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
var vadSpan = document.querySelector('#vad-indicator span')
var framesSpan = document.querySelector('#frames-indicator span')
var dropsSpan = document.querySelector('#drops-indicator span')
var nodeIdSpan = document.querySelector('#node-id span')
var nodeStateSpan = document.querySelector('#node-state span')
var nodeTransportSpan = document.querySelector('#node-transport span')
var upstreamSpan = document.querySelector('#upstream span')
var downstreamSpan = document.querySelector('#downstream span')

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
        vadEnabled: true,
        vadThreshold: 0.01
      })

      audio.on('speaking', function () {
        vadSpan.textContent = 'Speaking'
        vadSpan.parentElement.classList.add('active')
      })

      audio.on('silent', function () {
        vadSpan.textContent = 'Silent'
        vadSpan.parentElement.classList.remove('active')
      })

      await audio.start()
      updateStatus('Broadcasting...')
    } else {
      updateStatus('Starting listener...')
      audio = new AudioListener(node, {
        jitterBuffer: 60 // 60ms jitter buffer
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
  vadSpan.parentElement.classList.remove('active')
}

// Start connecting
updateStatus('Connecting to tree...')
node.connect()

// Update tree info initially
updateTreeInfo()
