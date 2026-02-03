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

    // VAD state
    this.speaking = false
    this.hangoverFrames = 0
    this.HANGOVER_FRAMES = 5 // Keep sending for 5 frames after speech stops
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

    // Only send if VAD disabled or currently speaking (includes hangover)
    if (!this.vadEnabled || this.speaking || this.hangoverFrames > 0) {
      // Copy buffer (it will be reused)
      var frame = new Float32Array(this.buffer)
      this.port.postMessage({
        type: 'frame',
        samples: frame
      }, [frame.buffer])
    }
  }
}

registerProcessor('capture-processor', CaptureProcessor)
