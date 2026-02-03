var AudioChannelManager = require('./src/channel')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

exports.AudioBroadcaster = AudioBroadcaster
exports.AudioListener = AudioListener
exports.AudioChannelManager = AudioChannelManager

inherits(AudioBroadcaster, EventEmitter)
inherits(AudioListener, EventEmitter)

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
 */
function AudioBroadcaster (node, opts) {
  if (!(this instanceof AudioBroadcaster)) return new AudioBroadcaster(node, opts)
  EventEmitter.call(this)

  opts = opts || {}
  this.node = node
  this.sampleRate = opts.sampleRate || 48000
  this.frameSize = opts.frameSize || 20
  this.bitrate = opts.bitrate || 24000
  this.vadEnabled = opts.vadEnabled !== false
  this.vadThreshold = opts.vadThreshold || 0.01
  this.workletUrl = opts.workletUrl || DEFAULT_CAPTURE_WORKLET

  this._channelManager = new AudioChannelManager(node, { relay: false })
  this._audioContext = null
  this._workletNode = null
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
  this._stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      sampleRate: this.sampleRate,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  })

  // Create audio context
  this._audioContext = new AudioContext({ sampleRate: this.sampleRate })

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

  // Initialize encoder
  this._encoder = await this._createEncoder()

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

  // Connect audio graph
  var source = this._audioContext.createMediaStreamSource(this._stream)
  source.connect(this._workletNode)
  // Don't connect to destination (no local monitoring)
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
  this.jitterBuffer = opts.jitterBuffer || 40
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
  this._audioContext = new AudioContext({ sampleRate: 48000 })

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
 * Stop listening
 */
AudioListener.prototype.stop = function () {
  if (!this._started) return
  this._started = false

  // Stop channel manager
  this._channelManager.stop()

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
}

/**
 * Create Opus decoder (or PCM fallback)
 */
AudioListener.prototype._createDecoder = async function () {
  var self = this

  // Check for WebCodecs Opus support
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
        sampleRate: 48000,
        numberOfChannels: 1
      })

      decoder._isOpus = true
      return decoder
    } catch (err) {
      console.warn('Opus decoder not supported, falling back to PCM:', err)
    }
  }

  // PCM fallback
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

  if (isOpus && this._decoder && this._decoder._isOpus) {
    // Decode Opus - use frame-based timestamp (20ms per frame = 20000 microseconds)
    var timestampMicros = this._frameCount * 20000
    var chunk = new EncodedAudioChunk({
      type: 'key',
      timestamp: timestampMicros,
      data: payload
    })
    this._decoder.decode(chunk)
    this._frameCount++
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
 * Send samples to playback worklet
 */
AudioListener.prototype._sendToWorklet = function (samples) {
  if (!this._workletNode) return
  this._workletNode.port.postMessage({
    type: 'samples',
    samples: samples
  }, [samples.buffer])
}
