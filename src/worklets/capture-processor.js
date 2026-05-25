/**
 * CaptureProcessor - AudioWorklet for microphone capture
 *
 * Accumulates 128-sample chunks into 20ms frames (960 samples @ 48kHz),
 * applies VAD to skip silent frames, and posts frames to main thread.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()

    var opts = options.processorOptions || {}
    this.frameSize = opts.frameSize || 20 // ms
    this.vadEnabled = opts.vadEnabled !== false
    this.vadThreshold = opts.vadThreshold || 0.01

    // Calculate samples per frame (e.g., 20ms @ 48kHz = 960 samples)
    this.samplesPerFrame = Math.floor(sampleRate * this.frameSize / 1000)

    // Accumulation buffer
    this.buffer = new Float32Array(this.samplesPerFrame)
    this.bufferIndex = 0

    // Pre-allocated buffer pool to avoid per-frame Float32Array allocation
    this.pool = []
    for (var i = 0; i < 8; i++) this.pool.push(new Float32Array(this.samplesPerFrame))

    // VAD state
    this.speaking = false
    this.hangoverFrames = 0
    this.HANGOVER_FRAMES = 15 // Keep sending for 15 frames (300ms) after speech stops

    // Handle messages from main thread (config updates + buffer returns)
    this.port.onmessage = this._onMessage.bind(this)
  }

  _onMessage (evt) {
    if (evt.data.type === 'config') {
      if (evt.data.vadEnabled !== undefined) {
        this.vadEnabled = evt.data.vadEnabled
      }
      if (evt.data.vadThreshold !== undefined) {
        this.vadThreshold = evt.data.vadThreshold
      }
    } else if (evt.data.type === 'return-buffer') {
      // Main thread returned a transferred buffer; wrap it back into a Float32Array
      this.pool.push(new Float32Array(evt.data.buffer))
    }
  }

  process (inputs, outputs) {
    var input = inputs[0]
    if (!input || !input[0]) return true

    var samples = input[0]

    // Accumulate samples
    for (var i = 0; i < samples.length; i++) {
      this.buffer[this.bufferIndex++] = samples[i]

      // Frame complete?
      if (this.bufferIndex >= this.samplesPerFrame) {
        this._processFrame()
        this.bufferIndex = 0
      }
    }

    return true
  }

  _processFrame () {
    // Calculate RMS for VAD
    var sumSquares = 0
    for (var i = 0; i < this.buffer.length; i++) {
      sumSquares += this.buffer[i] * this.buffer[i]
    }
    var rms = Math.sqrt(sumSquares / this.buffer.length)

    // VAD logic
    var isSpeech = rms >= this.vadThreshold

    if (isSpeech) {
      this.hangoverFrames = this.HANGOVER_FRAMES
      if (!this.speaking) {
        this.speaking = true
        this.port.postMessage({ type: 'vad', speaking: true })
      }
    } else if (this.hangoverFrames > 0) {
      this.hangoverFrames--
    } else if (this.speaking) {
      this.speaking = false
      this.port.postMessage({ type: 'vad', speaking: false })
    }

    // Detect speech onset (silent → speaking transition)
    var onset = isSpeech && !this._wasSpeaking
    this._wasSpeaking = this.speaking || this.hangoverFrames > 0

    // Only send if VAD disabled or currently speaking (includes hangover)
    if (!this.vadEnabled || this.speaking || this.hangoverFrames > 0) {
      // Grab a buffer from the pool (fallback to allocation if pool is exhausted)
      var frame = this.pool.length > 0 ? this.pool.pop() : new Float32Array(this.samplesPerFrame)
      frame.set(this.buffer)
      this.port.postMessage({
        type: 'frame',
        samples: frame,
        onset: onset && this.vadEnabled
      }, [frame.buffer])
    }
  }
}

registerProcessor('capture-processor', CaptureProcessor)
