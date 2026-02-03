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
  { name: 'Late-started listener receives audio', fn: scenario3 }
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
  // Test: Audio frames flow from broadcaster to listener
  var rootPage = await browser.newPage()
  attachLogger(rootPage, 'Broadcaster')
  await rootPage.goto('http://localhost:' + AUDIO_PORT + '/?root=true&path=' + TEST_PATH)
  await rootPage.waitForSelector('#start-btn:not([disabled])', { timeout: 15000 })

  await rootPage.click('#start-btn')
  await wait(500)
  // Resume AudioContext
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
  await wait(500)
  await childPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Listener started')

  // Wait for frames
  var gotFrames = await waitFor(childPage, function () {
    var el = document.querySelector('#frames-indicator span')
    return el && parseInt(el.textContent) > 5
  }, 10000, 'listener receives frames')

  var frameCount = await childPage.evaluate(function () {
    return parseInt(document.querySelector('#frames-indicator span').textContent)
  })
  log('Frames received: ' + frameCount)
  assert(frameCount > 5, 'Should receive more than 5 frames')

  await rootPage.close()
  await childPage.close()
}

async function scenario3 (browser) {
  // Test: Listener that starts AFTER connection still receives audio
  // This tests the late-binding bug fix
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

  // Now start the listener (late)
  await childPage.click('#start-btn')
  await wait(500)
  await childPage.evaluate(async function () {
    if (window.audio && window.audio._audioContext &&
        window.audio._audioContext.state === 'suspended') {
      await window.audio._audioContext.resume()
    }
  })
  log('Listener started (late)')

  // Wait for frames - this is where the bug would show
  var gotFrames = false
  try {
    gotFrames = await waitFor(childPage, function () {
      var el = document.querySelector('#frames-indicator span')
      return el && parseInt(el.textContent) > 5
    }, 10000, 'late listener receives frames')
  } catch (e) {
    // Expected to fail if bug exists
  }

  var frameCount = await childPage.evaluate(function () {
    return parseInt(document.querySelector('#frames-indicator span').textContent || '0')
  })
  log('Frames received by late listener: ' + frameCount)

  // Debug: check channel state
  var debug = await childPage.evaluate(function () {
    var node = window.node
    var audio = window.audio
    return {
      hasUpstream: !!node.upstream,
      upstreamAudio: node.upstream ? !!node.upstream._audio : null,
      upstreamAudioState: (node.upstream && node.upstream._audio) ? node.upstream._audio.readyState : null,
      channelManagerStarted: audio && audio._channelManager ? audio._channelManager._started : null
    }
  })
  log('Debug state: ' + JSON.stringify(debug))

  if (!gotFrames || frameCount < 5) {
    log('BUG CONFIRMED: Late-started listener does not receive frames')
    log('  This is because datachannel event fired before AudioListener.start()')
    throw new Error('Late listener should receive frames (got ' + frameCount + ')')
  }

  await rootPage.close()
  await childPage.close()
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
