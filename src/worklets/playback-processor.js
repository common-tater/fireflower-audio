/**
 * PlaybackProcessor - AudioWorklet for audio playback with jitter buffer
 *
 * Buffers incoming audio frames and plays them back smoothly,
 * handling network jitter and occasional packet loss.
 */
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor (options) {
    super()

    var opts = options.processorOptions || {}
    this.jitterBufferMs = opts.jitterBuffer || 40

    // Calculate buffer size in samples (e.g., 40ms @ 48kHz = 1920 samples)
    this.jitterBufferSamples = Math.floor(sampleRate * this.jitterBufferMs / 1000)

    // Ring buffer for samples
    this.ringBuffer = new Float32Array(sampleRate) // 1 second max
    this.writeIndex = 0
    this.readIndex = 0
    this.bufferedSamples = 0

    // State
    this.buffering = true // Wait for buffer to fill initially
    this.underruns = 0

    // Handle incoming samples from main thread
    this.port.onmessage = this._onMessage.bind(this)
  }

  _onMessage (evt) {
    if (evt.data.type === 'samples') {
      this._enqueueSamples(evt.data.samples)
    }
  }

  _enqueueSamples (samples) {
    for (var i = 0; i < samples.length; i++) {
      this.ringBuffer[this.writeIndex] = samples[i]
      this.writeIndex = (this.writeIndex + 1) % this.ringBuffer.length
      this.bufferedSamples++

      // Prevent overflow (drop oldest samples)
      if (this.bufferedSamples > this.ringBuffer.length) {
        this.readIndex = (this.readIndex + 1) % this.ringBuffer.length
        this.bufferedSamples--
      }
    }

    // Stop buffering if we have enough
    if (this.buffering && this.bufferedSamples >= this.jitterBufferSamples) {
      this.buffering = false
    }
  }

  process (inputs, outputs) {
    var output = outputs[0]
    if (!output || !output[0]) return true

    var channel = output[0]

    // Still buffering? Output silence
    if (this.buffering) {
      for (var i = 0; i < channel.length; i++) {
        channel[i] = 0
      }
      return true
    }

    // Fill output from ring buffer
    for (var j = 0; j < channel.length; j++) {
      if (this.bufferedSamples > 0) {
        channel[j] = this.ringBuffer[this.readIndex]
        this.readIndex = (this.readIndex + 1) % this.ringBuffer.length
        this.bufferedSamples--
      } else {
        // Underrun - output silence
        channel[j] = 0
        this.underruns++

        // After many underruns, go back to buffering mode
        if (this.underruns > 50) {
          this.buffering = true
          this.underruns = 0
        }
      }
    }

    return true
  }
}

registerProcessor('playback-processor', PlaybackProcessor)
