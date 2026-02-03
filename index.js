var AudioChannelManager = require('./src/channel')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var OpusDecoderLib = require('opus-decoder')

// Polyfill for navigator.mediaDevices.getUserMedia (Firefox mobile, older browsers)
function getMediaDevices () {
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    return navigator.mediaDevices
  }

  // Fallback to older APIs
  var getUserMedia = navigator.getUserMedia ||
    navigator.webkitGetUserMedia ||
    navigator.mozGetUserMedia ||
    navigator.msGetUserMedia

  if (!getUserMedia) {
    return null
  }

  // Wrap in promise-based API
  return {
    getUserMedia: function (constraints) {
      return new Promise(function (resolve, reject) {
        getUserMedia.call(navigator, constraints, resolve, reject)
      })
    }
  }
}

exports.AudioBroadcaster = AudioBroadcaster
exports.AudioListener = AudioListener
exports.AudioChannelManager = AudioChannelManager
exports.DEFAULTS = {
  sampleRate: DEFAULT_SAMPLE_RATE,
  frameSize: DEFAULT_FRAME_SIZE,
  bitrate: DEFAULT_BITRATE,
  vadThreshold: DEFAULT_VAD_THRESHOLD,
  jitterBuffer: DEFAULT_JITTER_BUFFER,
  compressorThreshold: DEFAULT_COMPRESSOR_THRESHOLD,
  compressorRatio: DEFAULT_COMPRESSOR_RATIO,
  inputGain: 1.0,
  vadEnabled: true,
  compressorEnabled: false,
  agcEnabled: false
}

inherits(AudioBroadcaster, EventEmitter)
inherits(AudioListener, EventEmitter)

// ─── Constants ───────────────────────────────────────────────────────────────
var DEFAULT_SAMPLE_RATE = 48000
var DEFAULT_FRAME_SIZE = 20 // ms
var DEFAULT_BITRATE = 24000 // bps
var DEFAULT_VAD_THRESHOLD = 0.01
var DEFAULT_JITTER_BUFFER = 40 // ms
var DEFAULT_COMPRESSOR_THRESHOLD = -12 // dB
var DEFAULT_COMPRESSOR_RATIO = 12
var HANGOVER_FRAMES = 15 // Keep sending for 15 frames (300ms) after speech stops
var SCRIPT_PROCESSOR_BUFFER = 4096
var ANALYSER_FFT_SIZE = 2048

// Default worklet URLs (relative to page, can be overridden via opts)
var DEFAULT_CAPTURE_WORKLET = '/worklets/capture-processor.js'
var DEFAULT_PLAYBACK_WORKLET = '/worklets/playback-processor.js'

/**
 * AudioBroadcaster - Captures microphone audio and broadcasts to tree
 *
 * @param {Object} node - fireflower Node instance (must be root)
 * @param {Object} opts - Configuration options
 * @param {number} opts.sampleRate - Audio sample rate (default: 48000)
 * @param {number} opts.frameSize - Frame size in ms (default: 20)
 * @param {number} opts.bitrate - Opus bitrate in bps (default: 24000)
 * @param {boolean} opts.vadEnabled - Enable voice activity detection (default: true)
 * @param {number} opts.vadThreshold - VAD RMS threshold (default: 0.01)
 * @param {string} opts.workletUrl - URL to capture-processor.js worklet
 * @param {boolean} opts.compressor - Enable dynamics compressor (default: false)
 * @param {number} opts.compressorThreshold - Compressor threshold in dB (default: -12)
 * @param {number} opts.compressorRatio - Compressor ratio (default: 12)
 * @param {number} opts.inputGain - Input gain multiplier (default: 1.0)
 * @param {boolean} opts.agcEnabled - Enable browser auto gain control (default: false)
 */
function AudioBroadcaster (node, opts) {
  if (!(this instanceof AudioBroadcaster)) return new AudioBroadcaster(node, opts)
  EventEmitter.call(this)

  opts = opts || {}
  this.node = node
  this.sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE
  this.frameSize = opts.frameSize || DEFAULT_FRAME_SIZE
  this.bitrate = opts.bitrate || DEFAULT_BITRATE
  this.vadEnabled = opts.vadEnabled !== false
  this.vadThreshold = opts.vadThreshold || DEFAULT_VAD_THRESHOLD
  this.workletUrl = opts.workletUrl || DEFAULT_CAPTURE_WORKLET

  // Compressor/gain options
  this.compressorEnabled = opts.compressor || false
  this.compressorThreshold = opts.compressorThreshold != null ? opts.compressorThreshold : DEFAULT_COMPRESSOR_THRESHOLD
  this.compressorRatio = opts.compressorRatio || DEFAULT_COMPRESSOR_RATIO
  this.inputGain = opts.inputGain || 1.0
  this.agcEnabled = opts.agcEnabled || false

  this._channelManager = new AudioChannelManager(node, { relay: false })
  this._audioContext = null
  this._workletNode = null
  this._compressorNode = null
  this._gainNode = null
  this._stream = null
  this._encoder = null
  this._started = false
  this._speaking = false
  this._sampleCount = 0 // Track samples for timestamp calculation
}

/**
 * Start broadcasting audio
 * @returns {Promise}
 */
AudioBroadcaster.prototype.start = async function () {
  if (this._started) return
  this._started = true

  var self = this

  // Start channel manager
  this._channelManager.start()

  // Request microphone access
  // Disable browser audio processing to avoid AGC pumping/tremolo artifacts
  var mediaDevices = getMediaDevices()
  if (!mediaDevices) {
    throw new Error('getUserMedia not supported. Broadcasting requires HTTPS on mobile browsers.')
  }

  // AGC (autoGainControl) is disabled by default to avoid pumping artifacts
  // Enable it for mobile devices where mic levels are too quiet
  this._stream = await mediaDevices.getUserMedia({
    audio: {
      sampleRate: this.sampleRate,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: this.agcEnabled
    }
  })

  // Create audio context
  this._audioContext = new AudioContext({ sampleRate: this.sampleRate })

  // Initialize encoder
  this._encoder = await this._createEncoder()

  // Connect audio graph - always create gain and compressor for live control
  var source = this._audioContext.createMediaStreamSource(this._stream)

  // Always create gain node for live adjustment
  this._gainNode = this._audioContext.createGain()
  this._gainNode.gain.value = this.inputGain

  // Always create compressor node for live adjustment
  // When disabled, ratio=1 effectively bypasses it
  this._compressorNode = this._audioContext.createDynamicsCompressor()
  this._compressorNode.threshold.value = this.compressorThreshold
  this._compressorNode.knee.value = 6
  this._compressorNode.ratio.value = this.compressorEnabled ? this.compressorRatio : 1
  this._compressorNode.attack.value = 0.003
  this._compressorNode.release.value = 0.1

  // Check for AudioWorklet support
  if (this._audioContext.audioWorklet) {
    // Load capture worklet
    await this._audioContext.audioWorklet.addModule(this.workletUrl)

    // Create worklet node
    this._workletNode = new AudioWorkletNode(this._audioContext, 'capture-processor', {
      processorOptions: {
        frameSize: this.frameSize,
        vadEnabled: this.vadEnabled,
        vadThreshold: this.vadThreshold
      }
    })

    // Handle messages from worklet
    this._workletNode.port.onmessage = function (evt) {
      if (evt.data.type === 'frame') {
        self._onFrame(evt.data.samples)
      } else if (evt.data.type === 'vad') {
        var wasSpeaking = self._speaking
        self._speaking = evt.data.speaking
        if (self._speaking && !wasSpeaking) {
          self.emit('speaking')
        } else if (!self._speaking && wasSpeaking) {
          self.emit('silent')
        }
      }
    }

    // Chain: source → gain → compressor → worklet
    source.connect(this._gainNode)
    this._gainNode.connect(this._compressorNode)
    this._compressorNode.connect(this._workletNode)
  } else {
    // Fallback: ScriptProcessorNode for browsers without AudioWorklet
    console.warn('[audio] AudioWorklet not supported, using ScriptProcessorNode fallback for capture')
    this._setupCaptureScriptProcessor(source)
  }
  // Don't connect to destination (no local monitoring)
}

/**
 * Setup ScriptProcessorNode fallback for capture (Firefox mobile)
 */
AudioBroadcaster.prototype._setupCaptureScriptProcessor = function (source) {
  var self = this
  var sampleRate = this._audioContext.sampleRate
  var samplesPerFrame = Math.floor(sampleRate * this.frameSize / 1000)

  // Accumulation buffer for frames
  this._captureBuffer = new Float32Array(samplesPerFrame)
  this._captureBufferIndex = 0

  // VAD state
  this._vadHangover = 0

  // ScriptProcessorNode
  this._scriptNode = this._audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1)

  this._scriptNode.onaudioprocess = function (evt) {
    var input = evt.inputBuffer.getChannelData(0)

    for (var i = 0; i < input.length; i++) {
      self._captureBuffer[self._captureBufferIndex++] = input[i]

      // Frame complete?
      if (self._captureBufferIndex >= samplesPerFrame) {
        // Calculate RMS for VAD
        var sumSquares = 0
        for (var j = 0; j < self._captureBuffer.length; j++) {
          sumSquares += self._captureBuffer[j] * self._captureBuffer[j]
        }
        var rms = Math.sqrt(sumSquares / self._captureBuffer.length)
        var isSpeech = rms >= self.vadThreshold

        // VAD logic with hangover
        if (isSpeech) {
          self._vadHangover = HANGOVER_FRAMES
          if (!self._speaking) {
            self._speaking = true
            self.emit('speaking')
          }
        } else if (self._vadHangover > 0) {
          self._vadHangover--
        } else if (self._speaking) {
          self._speaking = false
          self.emit('silent')
        }

        // Send frame if VAD disabled or speaking
        if (!self.vadEnabled || self._speaking || self._vadHangover > 0) {
          var frame = new Float32Array(self._captureBuffer)
          self._onFrame(frame)
        }

        self._captureBufferIndex = 0
      }
    }
  }

  // Chain: source → gain → compressor → scriptProcessor
  source.connect(this._gainNode)
  this._gainNode.connect(this._compressorNode)
  this._compressorNode.connect(this._scriptNode)
  // Connect to destination (required for ScriptProcessorNode to work, but silent)
  this._scriptNode.connect(this._audioContext.destination)
}

/**
 * Stop broadcasting
 */
AudioBroadcaster.prototype.stop = function () {
  if (!this._started) return
  this._started = false

  // Stop channel manager
  this._channelManager.stop()

  // Stop microphone
  if (this._stream) {
    this._stream.getTracks().forEach(function (track) { track.stop() })
    this._stream = null
  }

  // Disconnect script processor if using fallback
  if (this._scriptNode) {
    this._scriptNode.disconnect()
    this._scriptNode = null
  }

  // Close audio context
  if (this._audioContext) {
    this._audioContext.close()
    this._audioContext = null
  }

  // Close encoder
  if (this._encoder) {
    this._encoder.close()
    this._encoder = null
  }

  this._workletNode = null
  this._compressorNode = null
  this._gainNode = null
  this._speaking = false
}

/**
 * Create Opus encoder (or PCM fallback)
 */
AudioBroadcaster.prototype._createEncoder = async function () {
  var self = this

  // Check for WebCodecs Opus support
  if (typeof AudioEncoder !== 'undefined') {
    try {
      var encoder = new AudioEncoder({
        output: function (chunk) {
          self._onEncodedChunk(chunk)
        },
        error: function (err) {
          console.error('AudioEncoder error:', err)
        }
      })

      await encoder.configure({
        codec: 'opus',
        sampleRate: this.sampleRate,
        numberOfChannels: 1,
        bitrate: this.bitrate
      })

      encoder._isOpus = true
      return encoder
    } catch (err) {
      console.warn('Opus encoder not supported, falling back to PCM:', err)
    }
  }

  // PCM fallback (no actual encoder, just pass through)
  return {
    _isOpus: false,
    encode: function (data) {
      // Convert Float32 to Int16 PCM
      var samples = data.data
      var pcm = new Int16Array(samples.length)
      for (var i = 0; i < samples.length; i++) {
        var s = Math.max(-1, Math.min(1, samples[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      self._broadcastFrame(pcm.buffer, false)
    },
    close: function () {}
  }
}

/**
 * Handle audio frame from worklet
 */
AudioBroadcaster.prototype._onFrame = function (samples) {
  if (!this._encoder) return

  if (this._encoder._isOpus) {
    // WebCodecs encoder - use sample-based timestamp, not wall clock
    var timestampMicros = Math.floor(this._sampleCount * 1000000 / this.sampleRate)
    var data = new AudioData({
      format: 'f32',
      sampleRate: this.sampleRate,
      numberOfFrames: samples.length,
      numberOfChannels: 1,
      timestamp: timestampMicros,
      data: samples
    })
    this._encoder.encode(data)
    data.close()
    this._sampleCount += samples.length
  } else {
    // PCM fallback
    this._encoder.encode({ data: samples })
  }
}

/**
 * Handle encoded chunk from WebCodecs
 */
AudioBroadcaster.prototype._onEncodedChunk = function (chunk) {
  var data = new Uint8Array(chunk.byteLength)
  chunk.copyTo(data)
  this._broadcastFrame(data.buffer, true)
}

/**
 * Broadcast a frame to all downstream peers
 */
AudioBroadcaster.prototype._broadcastFrame = function (buffer, isOpus) {
  // Prepend 1-byte header: 0x01 = Opus, 0x00 = PCM
  var header = new Uint8Array([isOpus ? 0x01 : 0x00])
  var frame = new Uint8Array(1 + buffer.byteLength)
  frame.set(header)
  frame.set(new Uint8Array(buffer), 1)

  this._channelManager.broadcast(frame.buffer)
}

// ============================================================================
// AudioListener
// ============================================================================

/**
 * AudioListener - Receives and plays audio from the tree
 *
 * @param {Object} node - fireflower Node instance
 * @param {Object} opts - Configuration options
 * @param {number} opts.jitterBuffer - Jitter buffer size in ms (default: 40)
 * @param {string} opts.workletUrl - URL to playback-processor.js worklet
 */
function AudioListener (node, opts) {
  if (!(this instanceof AudioListener)) return new AudioListener(node, opts)
  EventEmitter.call(this)

  opts = opts || {}
  this.node = node
  this.jitterBuffer = opts.jitterBuffer || DEFAULT_JITTER_BUFFER
  this.workletUrl = opts.workletUrl || DEFAULT_PLAYBACK_WORKLET

  this._channelManager = new AudioChannelManager(node, { relay: true })
  this._audioContext = null
  this._workletNode = null
  this._decoder = null
  this._started = false
  this._frameCount = 0 // Track frames for timestamp calculation
}

/**
 * Start listening and playing audio
 * @returns {Promise}
 */
AudioListener.prototype.start = async function () {
  if (this._started) return
  this._started = true

  var self = this

  // Start channel manager
  this._channelManager.start()

  // Create audio context
  this._audioContext = new AudioContext({ sampleRate: DEFAULT_SAMPLE_RATE })

  // Resume audio context if suspended (browsers require user gesture)
  if (this._audioContext.state === 'suspended') {
    await this._audioContext.resume()
  }

  // Check for AudioWorklet support (Firefox mobile doesn't have it)
  if (this._audioContext.audioWorklet) {
    // Load playback worklet
    await this._audioContext.audioWorklet.addModule(this.workletUrl)

    // Create worklet node
    this._workletNode = new AudioWorkletNode(this._audioContext, 'playback-processor', {
      processorOptions: {
        jitterBuffer: this.jitterBuffer
      }
    })

    // Connect to speakers
    this._workletNode.connect(this._audioContext.destination)
  } else {
    // Fallback: ScriptProcessorNode for browsers without AudioWorklet
    console.warn('[audio] AudioWorklet not supported, using ScriptProcessorNode fallback')
    this._useScriptProcessor = true
    this._setupScriptProcessorFallback()
  }

  // Initialize decoder
  this._decoder = await this._createDecoder()

  // Handle incoming audio
  this._channelManager.on('audio', function (data) {
    self._onAudioData(data)
  })

  this._channelManager.on('drop', function () {
    self.emit('drop')
  })
}

/**
 * Setup ScriptProcessorNode fallback for browsers without AudioWorklet
 */
AudioListener.prototype._setupScriptProcessorFallback = function () {
  var self = this
  var sampleRate = this._audioContext.sampleRate

  // Ring buffer for jitter buffering
  var bufferSize = sampleRate // 1 second max
  this._ringBuffer = new Float32Array(bufferSize)
  this._writeIndex = 0
  this._readIndex = 0
  this._bufferedSamples = 0
  this._jitterBufferSamples = Math.floor(sampleRate * this.jitterBuffer / 1000)
  this._buffering = true

  // ScriptProcessorNode with 4096 buffer size
  // Note: ScriptProcessorNode is deprecated but widely supported
  this._scriptNode = this._audioContext.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 0, 1)

  this._scriptNode.onaudioprocess = function (evt) {
    var output = evt.outputBuffer.getChannelData(0)

    // Still buffering? Output silence
    if (self._buffering) {
      for (var i = 0; i < output.length; i++) {
        output[i] = 0
      }
      return
    }

    // Fill output from ring buffer
    for (var j = 0; j < output.length; j++) {
      if (self._bufferedSamples > 0) {
        output[j] = self._ringBuffer[self._readIndex]
        self._readIndex = (self._readIndex + 1) % bufferSize
        self._bufferedSamples--
      } else {
        output[j] = 0
      }
    }
  }

  this._scriptNode.connect(this._audioContext.destination)
}

/**
 * Enqueue samples for ScriptProcessorNode fallback
 */
AudioListener.prototype._enqueueScriptProcessorSamples = function (samples) {
  var bufferSize = this._ringBuffer.length

  for (var i = 0; i < samples.length; i++) {
    this._ringBuffer[this._writeIndex] = samples[i]
    this._writeIndex = (this._writeIndex + 1) % bufferSize
    this._bufferedSamples++

    // Prevent overflow
    if (this._bufferedSamples > bufferSize) {
      this._readIndex = (this._readIndex + 1) % bufferSize
      this._bufferedSamples--
    }
  }

  // Stop buffering if we have enough
  if (this._buffering && this._bufferedSamples >= this._jitterBufferSamples) {
    this._buffering = false
  }
}

/**
 * Stop listening
 */
AudioListener.prototype.stop = function () {
  if (!this._started) return
  this._started = false

  // Stop channel manager
  this._channelManager.stop()

  // Disconnect script processor if using fallback
  if (this._scriptNode) {
    this._scriptNode.disconnect()
    this._scriptNode = null
  }

  // Close audio context
  if (this._audioContext) {
    this._audioContext.close()
    this._audioContext = null
  }

  // Close decoder
  if (this._decoder) {
    this._decoder.close()
    this._decoder = null
  }

  this._workletNode = null
  this._useScriptProcessor = false
}

/**
 * Create Opus decoder (WebCodecs, opus-decoder library, or PCM fallback)
 */
AudioListener.prototype._createDecoder = async function () {
  var self = this

  // Try WebCodecs first (best performance)
  if (typeof AudioDecoder !== 'undefined') {
    try {
      var decoder = new AudioDecoder({
        output: function (audioData) {
          self._onDecodedAudio(audioData)
        },
        error: function (err) {
          console.error('AudioDecoder error:', err)
        }
      })

      await decoder.configure({
        codec: 'opus',
        sampleRate: DEFAULT_SAMPLE_RATE,
        numberOfChannels: 1
      })

      console.log('[audio] Using WebCodecs AudioDecoder')
      decoder._isOpus = true
      return decoder
    } catch (err) {
      console.warn('WebCodecs Opus not supported:', err)
    }
  }

  // Fallback to opus-decoder library (WASM)
  try {
    var OpusDecoder = OpusDecoderLib.OpusDecoder
    var wasmDecoder = new OpusDecoder({
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: 1
    })
    await wasmDecoder.ready

    console.log('[audio] Using opus-decoder WASM fallback')
    return {
      _isOpus: true,
      _wasmDecoder: wasmDecoder,
      decode: function (chunk) {
        // Get the Opus frame data
        var opusData = new Uint8Array(chunk.byteLength)
        chunk.copyTo ? chunk.copyTo(opusData) : (opusData = new Uint8Array(chunk.data))

        // Decode with opus-decoder
        var result = wasmDecoder.decodeFrame(opusData)
        if (result && result.samplesDecoded > 0) {
          // result.channelData is array of Float32Arrays
          var samples = result.channelData[0]
          self._sendToWorklet(samples)
        }
      },
      close: function () {
        wasmDecoder.free()
      }
    }
  } catch (err) {
    console.warn('opus-decoder WASM fallback failed:', err)
  }

  // PCM-only fallback (no Opus support)
  console.warn('[audio] No Opus decoder available, PCM only')
  return {
    _isOpus: false,
    decode: function () {},
    close: function () {}
  }
}

/**
 * Handle incoming audio data
 */
AudioListener.prototype._onAudioData = function (data) {
  var view = new Uint8Array(data)
  if (view.length < 2) return

  var isOpus = view[0] === 0x01
  var payload = view.slice(1)

  if (isOpus) {
    if (this._decoder && this._decoder._isOpus) {
      if (this._decoder._wasmDecoder) {
        // WASM opus-decoder path
        try {
          var result = this._decoder._wasmDecoder.decodeFrame(payload)
          if (result && result.samplesDecoded > 0) {
            var samples = result.channelData[0]
            this._sendToWorklet(samples)
          }
        } catch (err) {
          console.warn('[audio] WASM decode error:', err)
        }
      } else {
        // WebCodecs path
        var timestampMicros = this._frameCount * 20000
        var chunk = new EncodedAudioChunk({
          type: 'key',
          timestamp: timestampMicros,
          data: payload
        })
        this._decoder.decode(chunk)
      }
      this._frameCount++
    } else {
      // Can't decode Opus - drop frame and warn once
      if (!this._warnedOpus) {
        this._warnedOpus = true
        console.warn('[audio] Received Opus audio but no decoder available. Audio will not play.')
        this.emit('unsupported', { codec: 'opus' })
      }
      return
    }
  } else {
    // PCM: convert Int16 back to Float32
    var pcm = new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2)
    var samples = new Float32Array(pcm.length)
    for (var i = 0; i < pcm.length; i++) {
      samples[i] = pcm[i] / (pcm[i] < 0 ? 0x8000 : 0x7FFF)
    }
    this._sendToWorklet(samples)
  }

  this.emit('audio', { isOpus: isOpus, size: payload.length })
}

/**
 * Handle decoded audio from WebCodecs
 */
AudioListener.prototype._onDecodedAudio = function (audioData) {
  var samples = new Float32Array(audioData.numberOfFrames)
  audioData.copyTo(samples, { planeIndex: 0 })
  audioData.close()
  this._sendToWorklet(samples)
}

/**
 * Send samples to playback worklet (or fallback)
 */
AudioListener.prototype._sendToWorklet = function (samples) {
  if (this._useScriptProcessor) {
    // ScriptProcessorNode fallback
    this._enqueueScriptProcessorSamples(samples)
  } else if (this._workletNode) {
    // AudioWorklet path
    this._workletNode.port.postMessage({
      type: 'samples',
      samples: samples
    }, [samples.buffer])
  }
}
