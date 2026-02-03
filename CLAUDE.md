# Fireflower Audio

Low-latency audio broadcasting layer for Fireflower P2P trees. Uses Fireflower's extension points (`peerCreated`, `datachannel`) to add audio channels without modifying fireflower core.

## Architecture

- **index.js** — Main exports: `AudioBroadcaster`, `AudioListener`, `AudioChannelManager`
- **src/channel.js** — `AudioChannelManager` class. Creates `_audio` data channels on peers, handles relay logic.
- **src/worklets/** — AudioWorklet processors for capture and playback
- **example/** — Browser demo with broadcaster/listener modes

## Key Patterns

### Extension point usage
fireflower-audio hooks into fireflower's extension events:

```javascript
// Parent (initiator): create _audio channel before SDP negotiation
node.on('peerCreated', (peer) => {
  peer._audio = peer.createDataChannel('_audio', { ordered: false, maxRetransmits: 0 })
})

// Child (non-initiator): receive _audio channel
node.on('datachannel', (peer, channel) => {
  if (channel.label === '_audio') {
    peer._audio = channel
    channel.onmessage = (evt) => handleAudio(peer, evt)
  }
})
```

### Late-binding channel wiring
The `datachannel` event fires when the connection is established. If `AudioListener.start()` is called later (e.g., user clicks a button after connecting), the event is missed. fireflower stores custom channels in `peer._channels[label]` for late-binding:

```javascript
// In _wireUpstream, check both locations
var audioChannel = peer._audio || (peer._channels && peer._channels._audio)
if (audioChannel) {
  peer._audio = audioChannel
  audioChannel.onmessage = (evt) => this._onAudioData(peer, evt.data)
}
```

### Audio relay
Audio flows root → leaves, same direction as fireflower's broadcast data. Each node's `AudioChannelManager` automatically relays from upstream to all downstream peers. The `_onAudioData` handler emits for local playback and calls `_relayToDownstream`.

### Backpressure handling
Old audio is toxic — queuing stale frames builds latency. Drop frames if `bufferedAmount > 200`:

```javascript
if (peer._audio.bufferedAmount > AUDIO_BACKPRESSURE_THRESHOLD) {
  this.emit('drop', peer)
  return // Don't send
}
```

### Server transport limitation
`ServerTransport` uses WebSocket (TCP). Even with `ordered: false` on the channel, TCP enforces ordering underneath. Audio over server transport has higher latency and potential stalls. Nodes should upgrade to P2P for best quality.

## Important Lessons

### datachannel event timing
The `datachannel` event fires BEFORE the node's `connect` event. If an application waits for `connect` before creating `AudioListener`, the `datachannel` handler isn't registered in time. Fix: fireflower stores channels in `peer._channels` so `_wireUpstream` can find them later.

### AudioWorklet processor registration
AudioWorklet processors must be loaded via `audioContext.audioWorklet.addModule(url)` before creating `AudioWorkletNode`. The worklet files are served from `/worklets/` path by the example server.

### AudioContext suspension in browsers
Browsers suspend `AudioContext` until user interaction. The broadcaster gets implicit resume from `getUserMedia`, but the listener must explicitly resume after creating the context:
```javascript
if (audioContext.state === 'suspended') {
  await audioContext.resume()
}
```
Without this, the listener's audio playback silently fails.

### Browser AGC causes tremolo/pumping artifacts
Browser audio processing (AGC, noise suppression, echo cancellation) causes severe artifacts on sustained sounds - volume pulses in rapid waves. **Disable by default for broadcast audio**:
```javascript
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
})
```

### AGC option for quiet mobile mics
Mobile phone mics without AGC capture at much lower levels than desktop mics. The `agcEnabled` option re-enables browser AGC when volume matters more than avoiding artifacts. Combined with high input gain (up to 30x), this handles quiet mobile mics. AGC works well for voice with natural pauses; avoid for music/sustained tones.

### VAD hangover must be long enough for natural decay
The VAD (Voice Activity Detection) "hangover" is how long it keeps sending after speech drops below threshold. Too short (5 frames = 100ms) cuts off word endings. Use 15+ frames (300ms) for natural speech decay.

### VAD sensitivity is user-controllable
The VAD threshold (RMS energy level) can be adjusted via the UI. Lower thresholds (0.005) are more sensitive and detect quieter speech, higher thresholds (0.05) require louder audio to trigger. The example UI maps these to "High/Medium/Low/Very Low" sensitivity labels. Updates are sent to the worklet via `postMessage`.

### Compressor enables real-time adjustment
The dynamics compressor is always created (with ratio=1 to bypass when disabled), allowing live enable/disable without recreating the audio graph. Threshold and ratio are also adjustable in real-time via `AudioParam.value`.

### Timestamps must be sample-based, not wall clock
WebCodecs `AudioData` and `EncodedAudioChunk` timestamps must increment based on sample count, not `performance.now()`. Using wall clock time causes decoder timing issues.

### WebCodecs Opus fallback
Not all browsers support `AudioEncoder`/`AudioDecoder` with Opus (notably Firefox mobile). The library uses a tiered fallback:
1. **WebCodecs** (best performance, Chrome/Edge/Safari)
2. **opus-decoder WASM** (Firefox mobile, older browsers)
3. **PCM only** (if both fail, Opus audio won't play)

The `opus-decoder` package adds ~100KB gzipped to the bundle but enables Opus playback everywhere.

### Firefox mobile limitations
Firefox mobile lacks AudioWorklet support. The library falls back to ScriptProcessorNode (deprecated but stable) for audio playback. Combined with the WASM Opus decoder, Firefox mobile gets full functionality with slightly higher latency.

### HTTPS required for mobile broadcasting
Mobile browsers (Firefox, Safari) require HTTPS for `navigator.mediaDevices.getUserMedia()`. Broadcasting from mobile only works over HTTPS or localhost. Listening works over HTTP since it doesn't need mic access. The library includes a polyfill for the older `navigator.getUserMedia` API but this also requires secure context on modern mobile browsers.

### Safari considerations
- **AudioContext user gesture**: Safari requires user interaction before AudioContext can play. The example UI handles this with explicit Start buttons.
- **WebCodecs**: Safari 16.4+ supports WebCodecs. Older versions fall back to opus-decoder WASM.
- **AudioWorklet**: Safari 14.1+ supports AudioWorklet. Older versions fall back to ScriptProcessorNode.

### Form controls reset on page refresh
Browsers preserve form input values across page refreshes. The example UI explicitly resets all controls to defaults on load to avoid confusing state. Controls are not persisted to localStorage.

### Frame size trade-off
20ms frames (960 samples @ 48kHz) balance latency vs CPU overhead. 10ms doubles packet rate; 40ms adds noticeable latency.

### VAD prevents silent frame transmission
Voice Activity Detection checks RMS energy before encoding. Silent frames aren't sent, saving bandwidth across the entire tree.

## Dev Environment

### Related repos
- **fireflower** (`../fireflower-1`) — Core P2P library, provides extension points
- **fireflower-visualizer** (`../fireflower-visualizer`) — 3D visualization, reads Firebase reports

### Firebase
Uses same Firebase project as fireflower: **fireflower-test-viz**. Default path: `audio-tree`.

### Running
```bash
npm run dev      # Build + start example server on port 8085
npm test         # Run Puppeteer test suite (port 8086)
```

### Example URLs
- **Broadcaster (root)**: http://localhost:8085/?root=true
- **Listener**: http://localhost:8085/
- **3D visualizer**: http://localhost:8081/audio-tree (run fireflower-visualizer separately)

### Configurable Firebase path
Add `?path=<name>` to use a different Firebase path. The 3D visualizer uses URL pathname: `http://localhost:8081/<path>`.

## Testing

```bash
npm test           # Run all scenarios
node test/run.js 2 # Run only scenario 2
```

### Test scenarios
1. Extension point: _audio channel created and received
2. Audio data flows from broadcaster to listener
3. Late-started listener receives audio (tests late-binding fix)

Tests use Puppeteer with fake audio devices (`--use-fake-device-for-media-stream`).

## Build

```bash
npm run build  # esbuild bundles example/index.js → example/build.js
```

## GitHub

Repo: `common-tater/fireflower-audio`
