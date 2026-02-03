# Fireflower Audio - Design Document

Low-latency audio broadcasting layer for Fireflower P2P trees.

## Overview

Fireflower-audio adds live audio streaming on top of Fireflower's K-ary tree topology. Root node captures microphone audio, encodes it, and broadcasts to all nodes via the tree. Each intermediate node relays to its children.

**Key constraint**: Ultra-low latency for live audio (target: <150ms end-to-end for typical tree depths).

## Architecture

### Audio Pipeline

```
[Root Node - Broadcaster]
getUserMedia → AudioWorklet (128 samples @ 48kHz)
    → VAD check (skip silent frames)
    → accumulate to 20ms frame (960 samples)
    → WebCodecs OpusEncoder (or PCM fallback)
    → bufferedAmount check (drop if congested)
    → fireflower.send(encodedChunk)

[Intermediate Nodes - Relay]
fireflower._ondata() automatically relays to children
    → (same bufferedAmount drop logic applies)

[Leaf Nodes - Listeners]
fireflower.on('audio') → WebCodecs OpusDecoder (or PCM)
    → jitter buffer (fixed 40ms)
    → AudioWorklet playback
    → speakers
```

### Implementation Approach: Generic Extension Points

**Key principle**: fireflower-audio uses generic extension events exposed by fireflower-1. No audio-specific code in fireflower core.

fireflower-1 exposes two events for custom channels:
- `peerCreated(peer)` — fires on initiator before negotiation, allows creating channels to include in SDP
- `datachannel(peer, channel)` — fires on non-initiator when unknown channels arrive

fireflower-audio creates its own `_audio` data channels on each peer connection:

```javascript
// On initiator (parent): create audio channel before negotiation
node.on('peerCreated', (peer) => {
  peer._audio = peer.createDataChannel('_audio', {
    ordered: false,
    maxRetransmits: 0
  })
  peer._audio.onopen = () => wireAudioChannel(peer)
})

// On non-initiator (child): receive incoming audio channel
node.on('datachannel', (peer, channel) => {
  if (channel.label === '_audio') {
    peer._audio = channel
    channel.onmessage = (evt) => handleAudioData(peer, evt)
  }
})
```

**Why this works**:
- `peerCreated` event fires synchronously before SDP negotiation, so custom channels are in the initial offer
- `datachannel` event exposes unknown channels to external packages (fireflower core handles `_default` and `notifications` internally)
- Peer objects expose `createDataChannel()` for creating new channels with custom reliability options
- `node.downstream` and `node.upstream` give access to peer objects for relay logic

**fireflower-audio handles**:
- Audio channel creation and wiring on all peers
- Relay logic (forward audio from upstream to all downstream)
- Mic capture via AudioWorklet
- Opus encoding via WebCodecs (PCM fallback)
- VAD to skip silent frames
- Decoding and playback with jitter buffer

## Critical Design Decisions

### 1. Server Transport Limitation (TCP Reality)

**Problem**: `ServerTransport` uses WebSocket, which is TCP. Even with `ordered: false` on the logical channel, TCP enforces ordering and retransmission underneath. Head-of-line blocking is unavoidable.

**Implications**:
- P2P connections: True UDP-like semantics via SCTP — low latency, tolerates packet loss
- Server connections: TCP semantics — higher latency, potential stalls on packet loss

**Decision**:
- Document this limitation clearly
- Server-connected nodes CAN relay audio, but quality will be degraded
- Nodes should upgrade to P2P as soon as possible for best audio quality
- Future: WebTransport (QUIC-based) could fix this, but out of scope

### 2. Pre-Send Packet Dropping

**Problem**: If network is slow, `bufferedAmount` grows. Queuing old audio builds latency — old audio is worse than no audio.

**Solution**: Aggressive pre-send dropping with small threshold.

```javascript
const MAX_AUDIO_BUFFER = 200; // ~2 frames worth of Opus data

function sendAudio(channel, data) {
  if (channel.bufferedAmount > MAX_AUDIO_BUFFER) {
    return; // DROP. Do not queue stale audio.
  }
  channel.send(data);
}
```

This applies at every hop — broadcaster and relay nodes alike.

### 3. Voice Activity Detection (VAD)

**Problem**: Broadcasting silence wastes bandwidth. In K=2 tree with depth 7, one silent broadcaster causes 127 nodes to decode and relay nothing.

**Solution**: Energy-based VAD in AudioWorklet. Don't encode/send frames below threshold.

```javascript
// In capture worklet
const rms = Math.sqrt(samples.reduce((a, s) => a + s*s, 0) / samples.length);
if (rms < VAD_THRESHOLD) {
  return; // Silent frame, don't send
}
```

**Config**: `vadEnabled: true` (default), can disable for music/ambient use cases.

### 4. Frame Size: 20ms

**Trade-off**:
- 10ms: 100 packets/sec — excessive JS event loop overhead
- 20ms: 50 packets/sec — standard VoIP, good balance
- 40ms: 25 packets/sec — lower overhead, slightly higher latency

**Decision**: 20ms default. The 10ms latency savings isn't worth 2x CPU overhead, especially on relay nodes.

### 5. Separate `_audio` Channel

**Why not reuse `_default`?**
- Different reliability requirements (audio: unreliable, data: reliable)
- Don't want audio congestion to affect data delivery
- Cleaner separation of concerns

**Channel config**:
```javascript
{
  ordered: false,      // No head-of-line blocking (P2P only)
  maxRetransmits: 0    // Don't retry — old audio is useless
}
```

### 6. Encoding Strategy

**Primary**: WebCodecs Opus
- 94% browser support (Chrome 94+, Firefox 130+, Safari 26+)
- Hardware accelerated
- No WASM bundle needed
- Config: 24-32 kbps, 20ms frames, 48kHz

**Fallback**: PCM (for older browsers)
- 16kHz mono, 16-bit = 256 kbps
- Higher bandwidth but universal support
- Acceptable for voice

### 7. Jitter Buffer

**Strategy**: Fixed small buffer (40ms = 2 frames)

**Why fixed, not adaptive?**
- Simpler implementation
- Predictable latency
- For live broadcast, consistency > smoothness

**Trade-off**: May have occasional gaps on bad networks. Acceptable for live audio where "now" matters more than "perfect."

## Latency Budget

| Stage | Latency | Notes |
|-------|---------|-------|
| Mic → AudioWorklet | 5-20ms | Browser/OS dependent |
| Frame accumulation | 20ms | One frame |
| VAD + Opus encode | <1ms | Hardware accelerated |
| Network (per hop) | 10-50ms | LAN vs WAN |
| Opus decode | <1ms | Hardware accelerated |
| Jitter buffer | 40ms | Fixed 2-frame buffer |
| **Total (1 P2P hop)** | **~80-130ms** | |
| **Total (7 hops, worst case)** | **~150-400ms** | Deep tree on WAN |

Server transport adds unpredictable latency due to TCP HOL blocking.

## File Structure

```
fireflower-audio/
├── index.js                    # Main export: AudioBroadcaster, AudioListener
├── src/
│   ├── channel.js              # Audio channel creation and wiring on peers
│   ├── capture.js              # Mic capture via AudioWorklet
│   ├── encoder.js              # WebCodecs Opus + PCM fallback
│   ├── decoder.js              # WebCodecs Opus + PCM fallback
│   ├── playback.js             # Audio playback via Web Audio
│   ├── vad.js                  # Voice activity detection
│   ├── relay.js                # Audio relay logic (forward upstream to downstream)
│   └── worklets/
│       ├── capture-processor.js
│       └── playback-processor.js
├── example/
│   ├── index.html
│   ├── index.js
│   ├── style.css
│   └── server.js
├── package.json
├── DESIGN.md
└── README.md
```

## API Design

```javascript
import { AudioBroadcaster, AudioListener } from 'fireflower-audio';

// Root node (broadcaster)
const broadcaster = new AudioBroadcaster(fireflowerNode, {
  sampleRate: 48000,      // default
  frameSize: 20,          // ms, default
  bitrate: 24000,         // bps, default
  vadEnabled: true,       // default
  vadThreshold: 0.01      // RMS threshold, default
});

await broadcaster.start(); // Requests mic permission, starts capture
broadcaster.stop();

// Leaf node (listener)
const listener = new AudioListener(fireflowerNode, {
  jitterBuffer: 40        // ms, default
});

await listener.start();   // Starts playback context
listener.stop();

// Events
broadcaster.on('speaking', () => {});  // VAD triggered
broadcaster.on('silent', () => {});    // VAD ended
listener.on('audio', (stats) => {});   // Frame received
listener.on('drop', () => {});         // Frame dropped (jitter)
```

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebCodecs Opus | 94+ | 130+ | 26+ | 94+ |
| AudioWorklet | 66+ | 76+ | 14.1+ | 79+ |
| getUserMedia | 53+ | 36+ | 11+ | 12+ |

Fallback to PCM encoding for browsers without WebCodecs.

### 8. Disable Browser Audio Processing

**Problem**: Browser's AGC (Automatic Gain Control), noise suppression, and echo cancellation cause severe artifacts on sustained sounds — volume pulses in rapid waves (tremolo effect).

**Solution**: Disable all processing for broadcast audio:
```javascript
navigator.mediaDevices.getUserMedia({
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
})
```

**Why**: These features are designed for voice calls where both parties talk. For one-way broadcast, they fight against the audio and cause pumping artifacts. Raw audio is better for broadcast quality.

## Future Considerations

- **WebTransport**: Would fix server transport TCP limitation (QUIC supports unreliable streams)
- **Multiple broadcasters**: Currently single-broadcaster design; multi-party would need mixing
- **Optional echo cancellation**: Could be user-configurable for bidirectional use cases
- **Optional noise suppression**: Could be user-configurable for noisy environments
