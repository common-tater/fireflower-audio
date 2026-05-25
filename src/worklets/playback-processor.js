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

    // Dynamic jitter buffer state
    this.lastArrivalTime = 0
    this.ewmaJitter = 0
    this.alpha = 0.125 // EWMA smoothing constant (matches TCP SRTT)
    this.minBufferMs = 20
    this.maxBufferMs = 200
    this.packetCount = 0
    this.reportInterval = 50 // report stats every 50 packets (~1s at 20ms/frame)
    this.targetBufferMs = this.jitterBufferMs

    // Handle incoming samples from main thread
    this.port.onmessage = this._onMessage.bind(this)
  }

  _onMessage (evt) {
    if (evt.data.type === 'samples') {
      this._enqueueSamples(evt.data.samples)
    }
  }

  _enqueueSamples (samples) {
    // Track inter-packet jitter
    var now = currentTime * 1000 // AudioWorklet's currentTime in seconds → ms
    if (this.lastArrivalTime > 0) {
      var interval = now - this.lastArrivalTime
      var jitter = Math.abs(interval - 20) // 20ms expected interval
      this.ewmaJitter = this.ewmaJitter === 0 ? jitter : this.alpha * jitter + (1 - this.alpha) * this.ewmaJitter
      this.targetBufferMs = Math.max(this.minBufferMs, Math.min(this.maxBufferMs, 2 * this.ewmaJitter))
      // Growing: update target immediately so next buffering phase uses new size
      var newTarget = Math.floor(sampleRate * this.targetBufferMs / 1000)
      if (newTarget > this.jitterBufferSamples) {
        this.jitterBufferSamples = newTarget
      }
      // Shrinking: defer to underrun (re-buffering uses updated target naturally)
    }
    this.lastArrivalTime = now

    // Report stats periodically
    this.packetCount++
    if (this.packetCount % this.reportInterval === 0) {
      this.port.postMessage({
        type: 'jitter-stats',
        currentJitter: Math.round(this.ewmaJitter * 10) / 10,
        targetBuffer: Math.round(this.targetBufferMs),
        underruns: this.underruns
      })
    }

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

        // After many underruns, go back to buffering mode with current target
        if (this.underruns > 50) {
          this.buffering = true
          this.underruns = 0
          this.jitterBufferSamples = Math.floor(sampleRate * this.targetBufferMs / 1000)
        }
      }
    }

    return true
  }
}

registerProcessor('playback-processor', PlaybackProcessor)
