/**
 * Fireflower Audio Example
 *
 * Demonstrates live audio broadcasting through a fireflower P2P tree.
 * Root node captures mic and broadcasts; other nodes relay and play.
 */

var firebaseInit = require('../../fireflower-1/example/firebase-init')
var firebaseConfig = require('../../fireflower-1/example/firebase-config')
var fireflower = require('../../fireflower-1/')
var AudioBroadcaster = require('..').AudioBroadcaster
var AudioListener = require('..').AudioListener

// Initialize Firebase
var firebase = firebaseInit.init(firebaseConfig)

// Parse URL params
var params = new URLSearchParams(window.location.search)
var path = params.get('path') || 'audio-tree'
var isRoot = params.get('root') === 'true'

// UI elements
var statusEl = document.getElementById('status')
var startBtn = document.getElementById('start-btn')
var stopBtn = document.getElementById('stop-btn')
var modeBroadcaster = document.getElementById('mode-broadcaster')
var modeListener = document.getElementById('mode-listener')

// Audio settings controls
var compressorEnabledEl = document.getElementById('compressor-enabled')
var vadEnabledEl = document.getElementById('vad-enabled')
var inputGainEl = document.getElementById('input-gain')
var inputGainValueEl = document.getElementById('input-gain-value')
var compressorThresholdEl = document.getElementById('compressor-threshold')
var compressorThresholdValueEl = document.getElementById('compressor-threshold-value')
var compressorRatioEl = document.getElementById('compressor-ratio')
var compressorRatioValueEl = document.getElementById('compressor-ratio-value')

// Stats elements
var vadSpan = document.querySelector('#vad-indicator .stat-value')
var framesSpan = document.querySelector('#frames-indicator .stat-value')
var dropsSpan = document.querySelector('#drops-indicator .stat-value')

// Tree info elements
var nodeIdSpan = document.getElementById('node-id-value')
var nodeStateSpan = document.getElementById('node-state-value')
var nodeTransportSpan = document.getElementById('node-transport-value')
var upstreamSpan = document.getElementById('upstream-value')
var downstreamSpan = document.getElementById('downstream-value')

// State
var node = null
var audio = null // AudioBroadcaster or AudioListener
var frameCount = 0
var dropCount = 0

// Set initial mode based on URL
if (isRoot) {
  modeBroadcaster.checked = true
  modeListener.checked = false
}

// Slider value display updates
inputGainEl.oninput = function () {
  inputGainValueEl.textContent = parseFloat(inputGainEl.value).toFixed(1) + 'x'
}

compressorThresholdEl.oninput = function () {
  compressorThresholdValueEl.textContent = compressorThresholdEl.value + ' dB'
}

compressorRatioEl.oninput = function () {
  compressorRatioValueEl.textContent = compressorRatioEl.value + ':1'
}

// Create fireflower node
node = fireflower(firebase.db)(path, {
  root: isRoot,
  K: 2,
  serverFirst: true,
  reportInterval: 2500
})

// Expose for debugging
window.node = node

// Update UI on state changes
node.on('connect', updateTreeInfo)
node.on('disconnect', updateTreeInfo)
node.on('peerconnect', updateTreeInfo)
node.on('peerdisconnect', updateTreeInfo)

function updateTreeInfo () {
  nodeIdSpan.textContent = node.id.slice(-8)
  nodeStateSpan.textContent = node.state
  nodeTransportSpan.textContent = node.transport || '-'
  upstreamSpan.textContent = node.upstream ? node.upstream.id.slice(-8) : '-'

  var downIds = Object.keys(node.downstream)
    .filter(function (id) { return node.downstream[id].didConnect })
    .map(function (id) { return id.slice(-8) })
  downstreamSpan.textContent = downIds.length ? downIds.join(', ') : '-'
}

// Update status
function updateStatus (text) {
  statusEl.textContent = text
}

// Enable start button when connected
node.on('connect', function () {
  updateStatus('Connected to tree')
  startBtn.disabled = false
})

node.on('disconnect', function () {
  updateStatus('Disconnected')
  startBtn.disabled = true
  stopBtn.disabled = true
})

// Start button handler
startBtn.onclick = async function () {
  try {
    startBtn.disabled = true
    stopBtn.disabled = false

    var isBroadcaster = modeBroadcaster.checked

    if (isBroadcaster) {
      updateStatus('Starting broadcaster...')
      audio = new AudioBroadcaster(node, {
        vadEnabled: vadEnabledEl.checked,
        vadThreshold: 0.01,
        compressor: compressorEnabledEl.checked,
        compressorThreshold: parseInt(compressorThresholdEl.value),
        compressorRatio: parseInt(compressorRatioEl.value),
        inputGain: parseFloat(inputGainEl.value)
      })

      audio.on('speaking', function () {
        vadSpan.textContent = 'Speaking'
        document.getElementById('vad-indicator').classList.add('active')
      })

      audio.on('silent', function () {
        vadSpan.textContent = 'Silent'
        document.getElementById('vad-indicator').classList.remove('active')
      })

      await audio.start()
      updateStatus('Broadcasting...')
    } else {
      updateStatus('Starting listener...')
      audio = new AudioListener(node, {
        jitterBuffer: 60
      })

      audio.on('audio', function () {
        frameCount++
        framesSpan.textContent = frameCount
      })

      audio.on('drop', function () {
        dropCount++
        dropsSpan.textContent = dropCount
      })

      await audio.start()
      updateStatus('Listening...')
    }

    window.audio = audio
  } catch (err) {
    console.error('Start failed:', err)
    updateStatus('Error: ' + err.message)
    startBtn.disabled = false
    stopBtn.disabled = true
  }
}

// Stop button handler
stopBtn.onclick = function () {
  if (audio) {
    audio.stop()
    audio = null
  }
  startBtn.disabled = false
  stopBtn.disabled = true
  updateStatus('Stopped')
  vadSpan.textContent = '-'
  document.getElementById('vad-indicator').classList.remove('active')
}

// Start connecting
updateStatus('Connecting to tree...')
node.connect()

// Update tree info initially
updateTreeInfo()
