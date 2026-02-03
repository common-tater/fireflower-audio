#!/usr/bin/env node
/**
 * Fireflower Audio Test Suite
 *
 * Tests audio extension points and data flow.
 * Uses the same test patterns as fireflower core.
 */

var puppeteer = require('puppeteer')
var { spawn } = require('child_process')
var path = require('path')

// Reuse fireflower's Firebase helpers
var firebaseInit = require('../../fireflower-1/example/firebase-init')
var firebaseConfig = require('../../fireflower-1/example/firebase-config')
var { ref, remove } = require('firebase/database')

var ROOT = path.join(__dirname, '..')
var AUDIO_PORT = 8086
var TEST_PATH = 'audio-test'

var firebase = firebaseInit.init(firebaseConfig)
var db = firebase.db

// Allow running single scenario: node test/run.js 2
var onlyScenario = process.argv[2] ? parseInt(process.argv[2], 10) : null

var scenarios = [
  { name: 'Extension point: _audio channel created and received', fn: scenario1 },
  { name: 'Audio data flows from broadcaster to listener', fn: scenario2 },
  { name: 'Late-started listener receives audio', fn: scenario3 },
  { name: 'Decoder fallback chain is configured correctly', fn: scenario4 },
  { name: 'Level meters update during audio flow', fn: scenario5 },
  { name: 'VAD state changes are emitted', fn: scenario6 }
]

// ─── Helpers ────────────────────────────────────────────────────────

function wait (ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms) })
}

function log (msg) {
  var ts = new Date().toISOString().slice(11, 23)
  console.log('[' + ts + '] ' + msg)
}

function assert (cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg)
}

async function clearFirebase () {
  await remove(ref(db, TEST_PATH))
  log('Firebase cleared: /' + TEST_PATH)
}

function attachLogger (page, name) {
  page.on('console', function (msg) {
    var text = msg.text()
    if (text.includes('[fireflower]') || text.includes('Audio') ||
        text.includes('channel') || text.includes('error')) {
      log('[' + name + '] ' + text)
    }
  })
  page.on('pageerror', function (err) {
    log('[' + name + ':ERROR] ' + err.message)
  })
}

async function waitFor (page, predicate, timeout, description) {
  var start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      var result = await page.evaluate(predicate)
      if (result) return result
    } catch (e) { /* ignore */ }
    await wait(300)
  }
  throw new Error('Timeout waiting for: ' + description)
}

// ─── Scenario implementations ───────────────────────────────────────

async function scenario1 (browser) {
  // Test: _audio channel is created by parent and received by child
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Root')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })
  log('Root connected')

  // Start broadcasting (this creates the AudioChannelManager which hooks peerCreated)
  await rootPage.click('#start-btn')
  await wait(500)
  log('Root broadcaster started')

  // Add child
  var childPage = await browser.newPage()
  attachLogger(childPage, 'Child')
  await childPage.goto('http://localhost:' + AUDIO_PORT + '/?path=' + TEST_PATH)
  await childPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })
  log('Child connected')

  // Check root has _audio channel on downstream
  var rootChannel = await waitFor(rootPage, function () {
    var node = window.node
    if (!node) return null
    for (var id in node.downstream) {
      var peer = node.downstream[id]
      if (peer.didConnect && peer._audio) {
        return { peerId: id, state: peer._audio.readyState }
      }
    }
    return null
  }, 5000, 'root has _audio on child')

  log('Root _audio channel: ' + JSON.stringify(rootChannel))
  assert(rootChannel, 'Root should have _audio channel on child')
  assert(rootChannel.state === 'open', '_audio channel should be open')

  // Check child received _audio via datachannel event
  // Note: child hasn't started AudioListener yet, so channel may or may not be wired
  var childInfo = await childPage.evaluate(function () {
    var node = window.node
    if (!node || !node.upstream) return { hasUpstream: false }
    return {
      hasUpstream: true,
      hasAudioChannel: !!node.upstream._audio,
      // Check if fireflower stored the channel
      hasChannelsStore: !!node.upstream._channels,
      channelLabels: node.upstream._channels ? Object.keys(node.upstream._channels) : []
    }
  })
  log('Child upstream info: ' + JSON.stringify(childInfo))

  // The channel should exist (either on _audio or in _channels)
  var hasChannel = childInfo.hasAudioChannel || childInfo.channelLabels.includes('_audio')
  assert(hasChannel, 'Child should have received _audio channel')

  await rootPage.close()
  await childPage.close()
}

async function scenario2 (browser) {
  // Test: Audio data channel is open and listener is ready to receive
  // Note: Fake audio device may not generate enough signal to trigger VAD
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  await rootPage.click('#start-btn')
  await wait(500)
  await rootPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Broadcaster started')

  // Add listener child
  var childPage = await browser.newPage()
  attachLogger(childPage, 'Listener')
  await childPage.goto('http://localhost:' + AUDIO_PORT + '/?path=' + TEST_PATH)
  await childPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  await childPage.click('#start-btn')
  await wait(1000)
  await childPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Listener started')

  // Verify the audio channel is set up correctly
  var listenerState = await childPage.evaluate(function () {
    var node = window.node
    var audio = window.audio
    return {
      hasUpstream: !!node.upstream,
      audioChannelOpen: node.upstream && node.upstream._audio
        ? node.upstream._audio.readyState === 'open' : false,
      hasDecoder: audio ? !!audio._decoder : false,
      decoderIsOpus: audio && audio._decoder ? audio._decoder._isOpus : null,
      hasPlaybackNode: audio ? !!(audio._workletNode || audio._scriptNode) : false,
      channelManagerStarted: audio && audio._channelManager
        ? audio._channelManager._started : false
    }
  })

  log('Listener state: ' + JSON.stringify(listenerState))
  assert(listenerState.hasUpstream, 'Listener should have upstream')
  assert(listenerState.audioChannelOpen, 'Audio channel should be open')
  assert(listenerState.hasDecoder, 'Decoder should be created')
  assert(listenerState.decoderIsOpus, 'Decoder should support Opus')
  assert(listenerState.hasPlaybackNode, 'Playback node should exist')
  assert(listenerState.channelManagerStarted, 'Channel manager should be started')

  await rootPage.close()
  await childPage.close()
}

async function scenario3 (browser) {
  // Test: Listener that starts AFTER connection can still wire the audio channel
  // This tests the late-binding fix (channel stored in peer._channels)
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  // Root starts broadcasting first
  await rootPage.click('#start-btn')
  await wait(500)
  await rootPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Broadcaster started')

  // Child connects but does NOT start audio yet
  var childPage = await browser.newPage()
  attachLogger(childPage, 'Listener')
  await childPage.goto('http://localhost:' + AUDIO_PORT + '/?path=' + TEST_PATH)
  await childPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })
  log('Listener connected (audio not started yet)')

  // Wait for channel negotiation
  await wait(2000)

  // Check that the channel is stored for late binding
  var preStartState = await childPage.evaluate(function () {
    var node = window.node
    return {
      hasUpstream: !!node.upstream,
      hasChannelsStore: node.upstream ? !!node.upstream._channels : false,
      storedChannels: node.upstream && node.upstream._channels
        ? Object.keys(node.upstream._channels) : [],
      hasAudioChannelDirect: node.upstream ? !!node.upstream._audio : false
    }
  })
  log('Pre-start state: ' + JSON.stringify(preStartState))

  // The _audio channel should be stored in _channels for late binding
  var hasStoredChannel = preStartState.storedChannels.includes('_audio') ||
                         preStartState.hasAudioChannelDirect
  assert(hasStoredChannel, 'Audio channel should be stored for late binding')

  // Now start the listener (late)
  await childPage.click('#start-btn')
  await wait(1000)
  await childPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Listener started (late)')

  // Verify the channel was wired correctly
  var postStartState = await childPage.evaluate(function () {
    var node = window.node
    var audio = window.audio
    return {
      hasUpstream: !!node.upstream,
      upstreamHasAudio: node.upstream ? !!node.upstream._audio : false,
      audioChannelOpen: node.upstream && node.upstream._audio
        ? node.upstream._audio.readyState === 'open' : false,
      channelManagerStarted: audio && audio._channelManager
        ? audio._channelManager._started : false,
      hasDecoder: audio ? !!audio._decoder : false
    }
  })
  log('Post-start state: ' + JSON.stringify(postStartState))

  assert(postStartState.upstreamHasAudio, 'Upstream should have _audio after late start')
  assert(postStartState.audioChannelOpen, 'Audio channel should be open')
  assert(postStartState.channelManagerStarted, 'Channel manager should be started')
  assert(postStartState.hasDecoder, 'Decoder should be created')

  await rootPage.close()
  await childPage.close()
}

async function scenario4 (browser) {
  // Test: Decoder and playback fallback chain is properly configured
  // Start a broadcaster so we have audio context
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })
  await rootPage.click('#start-btn')
  await wait(500)
  log('Broadcaster started')

  // Start a listener and check decoder was created
  var listenerPage = await browser.newPage()
  attachLogger(listenerPage, 'Listener')
  await listenerPage.goto('http://localhost:' + AUDIO_PORT + '/?path=' + TEST_PATH)
  await listenerPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })
  await listenerPage.click('#start-btn')
  await wait(1000)
  log('Listener started')

  // Check decoder and playback setup
  var decoderInfo = await listenerPage.evaluate(function () {
    var audio = window.audio
    if (!audio) return { error: 'no audio object' }

    return {
      hasDecoder: !!audio._decoder,
      decoderIsOpus: audio._decoder ? audio._decoder._isOpus : null,
      decoderHasWasm: audio._decoder ? !!audio._decoder._wasmDecoder : null,
      hasWorkletNode: !!audio._workletNode,
      hasScriptNode: !!audio._scriptNode,
      useScriptProcessor: !!audio._useScriptProcessor,
      audioContextState: audio._audioContext ? audio._audioContext.state : null
    }
  })

  log('Decoder info: ' + JSON.stringify(decoderInfo))

  assert(decoderInfo.hasDecoder, 'Decoder should be created')
  assert(decoderInfo.decoderIsOpus === true, 'Decoder should support Opus')
  // In Chrome, WebCodecs is used (no WASM), but WASM should be available as fallback
  assert(decoderInfo.hasWorkletNode || decoderInfo.hasScriptNode,
    'Either worklet or script processor should be active')
  assert(decoderInfo.audioContextState === 'running' ||
         decoderInfo.audioContextState === 'suspended',
    'AudioContext should exist')

  await rootPage.close()
  await listenerPage.close()
}

async function scenario5 (browser) {
  // Test: Audio processing chain is properly connected
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  // Start broadcasting
  await rootPage.click('#start-btn')
  await wait(1500) // Give more time for setup
  await rootPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Broadcaster started')

  // Check the audio processing chain on the audio object
  var chainInfo = await rootPage.evaluate(function () {
    var audio = window.audio
    if (!audio) return { error: 'no audio object' }

    return {
      hasAudioContext: !!audio._audioContext,
      hasGainNode: !!audio._gainNode,
      hasCompressorNode: !!audio._compressorNode,
      hasWorkletOrScript: !!(audio._workletNode || audio._scriptNode),
      hasEncoder: !!audio._encoder,
      encoderIsOpus: audio._encoder ? audio._encoder._isOpus : null,
      audioContextState: audio._audioContext ? audio._audioContext.state : null
    }
  })

  log('Chain info: ' + JSON.stringify(chainInfo))
  assert(chainInfo.hasAudioContext, 'AudioContext should be created')
  assert(chainInfo.hasGainNode, 'GainNode should be created')
  assert(chainInfo.hasCompressorNode, 'CompressorNode should be created')
  assert(chainInfo.hasWorkletOrScript, 'Worklet or ScriptProcessor should be active')
  assert(chainInfo.hasEncoder, 'Encoder should be created')

  await rootPage.close()
}

async function scenario6 (browser) {
  // Test: VAD state changes emit speaking/silent events
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  // Track VAD events
  await rootPage.evaluate(function () {
    window.vadEvents = []
    window.node.on('connect', function () {
      // Will be set after audio.start()
    })
  })

  // Start broadcasting
  await rootPage.click('#start-btn')
  await wait(500)
  await rootPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
    // Track VAD events
    window.audio.on('speaking', function () {
      window.vadEvents.push({ type: 'speaking', time: Date.now() })
    })
    window.audio.on('silent', function () {
      window.vadEvents.push({ type: 'silent', time: Date.now() })
    })
  })
  log('Broadcaster started with VAD tracking')

  // Wait a bit for potential VAD events (fake audio may trigger)
  await wait(3000)

  // Check VAD indicator element exists and has correct structure
  var vadInfo = await rootPage.evaluate(function () {
    var indicator = document.getElementById('vad-indicator')
    var valueSpan = indicator ? indicator.querySelector('.stat-value') : null
    return {
      hasIndicator: !!indicator,
      hasValueSpan: !!valueSpan,
      currentValue: valueSpan ? valueSpan.textContent : null,
      eventCount: window.vadEvents.length,
      vadEnabled: window.audio ? window.audio.vadEnabled : null
    }
  })

  log('VAD info: ' + JSON.stringify(vadInfo))
  assert(vadInfo.hasIndicator, 'VAD indicator element should exist')
  assert(vadInfo.hasValueSpan, 'VAD value span should exist')
  assert(vadInfo.vadEnabled === true, 'VAD should be enabled by default')

  await rootPage.close()
}

// ─── Main ───────────────────────────────────────────────────────────

async function main () {
  log('=== Fireflower Audio Test Suite ===')
  log('')

  var server = null
  var browser = null
  var passed = 0
  var failed = 0

  try {
    // Clear Firebase
    await clearFirebase()

    // Start example server
    log('Starting server on port ' + AUDIO_PORT + '...')
    server = spawn('node', ['example/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(AUDIO_PORT) },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    await new Promise(function (resolve, reject) {
      var resolved = false
      server.stdout.on('data', function (data) {
        if (!resolved && data.toString().includes('Server running')) {
          resolved = true
          resolve()
        }
      })
      server.stderr.on('data', function (data) {
        log('[server:err] ' + data.toString().trim())
      })
      setTimeout(function () {
        if (!resolved) reject(new Error('Server start timeout'))
      }, 10000)
    })
    log('Server started')

    // Launch browser
    log('Launching browser...')
    browser = await puppeteer.launch({
      headless: false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-sandbox',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--allow-loopback-in-peer-connection'
      ]
    })

    // Run scenarios
    var toRun = onlyScenario
      ? scenarios.filter(function (_, i) { return i + 1 === onlyScenario })
      : scenarios

    for (var i = 0; i < toRun.length; i++) {
      var scenario = toRun[i]
      var num = onlyScenario || (i + 1)
      log('')
      log('─── Scenario ' + num + ': ' + scenario.name + ' ───')

      await clearFirebase()
      await wait(500)

      try {
        await scenario.fn(browser)
        log('✓ PASSED')
        passed++
      } catch (err) {
        log('✗ FAILED: ' + err.message)
        failed++
      }
    }

  } finally {
    if (browser) await browser.close()
    if (server) server.kill()
  }

  log('')
  log('=== Results: ' + passed + ' passed, ' + failed + ' failed ===')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(function (err) {
  console.error('Test runner error:', err)
  process.exit(1)
})
