# fireflower-audio

Low-latency audio broadcasting layer for [Fireflower](https://github.com/common-tater/fireflower) P2P trees.

## Features

- **Low latency**: ~80-130ms end-to-end for single P2P hop
- **Scalable**: Uses Fireflower's K-ary tree topology for broadcast
- **Opus encoding**: WebCodecs Opus with PCM fallback for older browsers
- **Voice Activity Detection**: Skip silent frames to save bandwidth
- **Pre-send packet dropping**: Drops stale audio instead of building latency
- **Zero Fireflower modifications**: Works with Fireflower as-is

## Installation

```bash
npm install fireflower-audio fireflower
```

## Usage

### Broadcaster (Root Node)

```javascript
import fireflower from 'fireflower'
import { AudioBroadcaster } from 'fireflower-audio'

// Create fireflower node (root)
const node = fireflower(firebase.db)('tree', { root: true })
node.connect()

node.on('connect', async () => {
  // Start broadcasting audio
  const broadcaster = new AudioBroadcaster(node, {
    sampleRate: 48000,      // default
    frameSize: 20,          // ms, default
    bitrate: 24000,         // bps, default
    vadEnabled: true,       // default
    vadThreshold: 0.01,     // RMS threshold, default
    inputGain: 1.0,         // gain multiplier, default
    compressor: false,      // dynamics compressor, default
    compressorThreshold: -12, // dB, default
    compressorRatio: 12     // compression ratio, default
  })

  await broadcaster.start() // Requests mic permission

  // Events
  broadcaster.on('speaking', () => console.log('Speaking'))
  broadcaster.on('silent', () => console.log('Silent'))
})
```

### Listener (Any Node)

```javascript
import fireflower from 'fireflower'
import { AudioListener } from 'fireflower-audio'

// Create fireflower node
const node = fireflower(firebase.db)('tree', { root: false })
node.connect()

node.on('connect', async () => {
  // Start listening
  const listener = new AudioListener(node, {
    jitterBuffer: 40        // ms, default
  })

  await listener.start()

  // Events
  listener.on('audio', (stats) => console.log('Audio received:', stats))
  listener.on('drop', () => console.log('Frame dropped'))
})
```

## How It Works

fireflower-audio creates its own `_audio` data channels on each peer connection:

- **P2P connections**: Unreliable/unordered channels (UDP-like via SCTP)
- **Server connections**: Reliable channels (TCP via WebSocket - higher latency)

Each intermediate node automatically relays audio from its upstream to all downstream peers, maintaining the tree broadcast pattern.

### Latency Budget

| Stage | Latency | Notes |
|-------|---------|-------|
| Mic → AudioWorklet | 5-20ms | Browser/OS dependent |
| Frame accumulation | 20ms | One frame |
| VAD + Opus encode | <1ms | Hardware accelerated |
| Network (per hop) | 10-50ms | LAN vs WAN |
| Opus decode | <1ms | Hardware accelerated |
| Jitter buffer | 40ms | Fixed 2-frame buffer |
| **Total (1 P2P hop)** | **~80-130ms** | |

## Audio Quality Notes

**Browser audio processing is disabled** by default. AGC (Automatic Gain Control), noise suppression, and echo cancellation cause tremolo/pumping artifacts on sustained sounds. For broadcast audio, raw capture sounds better.

If you need these features (e.g., for noisy environments), they can be re-enabled via getUserMedia constraints, but expect some audio artifacts.

## Server Transport Limitation

When a node connects via the relay server (WebSocket), the underlying transport is TCP, not UDP. This means:

- Ordered delivery is enforced (head-of-line blocking)
- Packet loss causes retransmission delays

For best audio quality, nodes should upgrade to P2P connections as soon as possible. Fireflower handles this automatically via its upgrade mechanism.

## Browser Support

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebCodecs Opus | 94+ | 130+ | 26+ | 94+ |
| AudioWorklet | 66+ | 76+ | 14.1+ | 79+ |
| getUserMedia | 53+ | 36+ | 11+ | 12+ |

Browsers without WebCodecs Opus fall back to PCM encoding (higher bandwidth but works).

## API

### AudioBroadcaster

```javascript
new AudioBroadcaster(node, options)
```

**Options:**
- `sampleRate` (number): Audio sample rate, default 48000
- `frameSize` (number): Frame size in ms, default 20
- `bitrate` (number): Opus bitrate in bps, default 24000
- `vadEnabled` (boolean): Enable VAD, default true
- `vadThreshold` (number): VAD RMS threshold, default 0.01
- `inputGain` (number): Input gain multiplier, default 1.0
- `compressor` (boolean): Enable dynamics compressor, default false
- `compressorThreshold` (number): Compressor threshold in dB, default -12
- `compressorRatio` (number): Compressor ratio, default 12

**Methods:**
- `start()`: Start capturing and broadcasting (returns Promise)
- `stop()`: Stop broadcasting

**Events:**
- `speaking`: VAD detected speech start
- `silent`: VAD detected speech end

### AudioListener

```javascript
new AudioListener(node, options)
```

**Options:**
- `jitterBuffer` (number): Jitter buffer size in ms, default 40

**Methods:**
- `start()`: Start receiving and playing (returns Promise)
- `stop()`: Stop listening

**Events:**
- `audio`: Frame received (stats: `{ isOpus, size }`)
- `drop`: Frame dropped due to backpressure

## Running the Example

```bash
npm run dev  # Builds and starts server on port 8085
```

- **Broadcaster**: http://localhost:8085/?root=true
- **Listener**: http://localhost:8085/

To see nodes in the 3D visualizer, run [fireflower-visualizer](https://github.com/common-tater/fireflower-visualizer) and open http://localhost:8081/audio-tree

## Testing

```bash
npm test           # Run all test scenarios
node test/run.js 2 # Run specific scenario
```

Uses Puppeteer with fake audio devices.

## License

MIT
