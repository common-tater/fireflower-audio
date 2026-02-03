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
var vadThresholdEl = document.getElementById('vad-threshold')
var vadThresholdValueEl = document.getElementById('vad-threshold-value')
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

// Visualization canvases
var compressorCurveCanvas = document.getElementById('compressor-curve')
var compressorCurveCtx = compressorCurveCanvas.getContext('2d')
var levelMeterCanvas = document.getElementById('level-meter')
var levelMeterCtx = levelMeterCanvas.getContext('2d')
var outputMeterCanvas = document.getElementById('output-meter')
var outputMeterCtx = outputMeterCanvas.getContext('2d')
var listenerOutputMeterCanvas = document.getElementById('listener-output-meter')
var listenerOutputMeterCtx = listenerOutputMeterCanvas.getContext('2d')

// State
var node = null
var audio = null // AudioBroadcaster or AudioListener
var analyser = null
var analyserData = null
var outputAnalyser = null
var outputAnalyserData = null
var animationId = null
var frameCount = 0
var dropCount = 0

// ─── Compressor Curve Visualization ─────────────────────────────────
// Colors mirror CSS variables: --color-bg-input (#252542), --color-accent (#00d9ff),
// --color-danger (#ff4757), --color-success (#2ed573), --color-warning (#ffa502)
var currentInputDb = -60 // Track current input level for visualization

function drawCompressorCurve () {
  var w = compressorCurveCanvas.width
  var h = compressorCurveCanvas.height
  var ctx = compressorCurveCtx
  var threshold = parseInt(compressorThresholdEl.value)
  var ratio = compressorEnabledEl.checked ? parseInt(compressorRatioEl.value) : 1

  // Clear
  ctx.fillStyle = '#252542'
  ctx.fillRect(0, 0, w, h)

  // Draw grid
  ctx.strokeStyle = '#333'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (var i = 0; i <= 4; i++) {
    var x = (i / 4) * w
    var y = (i / 4) * h
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  // Draw 1:1 reference line (diagonal)
  ctx.strokeStyle = '#444'
  ctx.setLineDash([4, 4])
  ctx.beginPath()
  ctx.moveTo(0, h)
  ctx.lineTo(w, 0)
  ctx.stroke()
  ctx.setLineDash([])

  // Draw compressor curve
  // X-axis: input dB (-60 to 0)
  // Y-axis: output dB (-60 to 0)
  ctx.strokeStyle = '#00d9ff'
  ctx.lineWidth = 2
  ctx.beginPath()

  for (var dB = -60; dB <= 0; dB += 1) {
    var outputDb
    if (dB < threshold) {
      outputDb = dB // Below threshold: 1:1
    } else {
      // Above threshold: apply ratio
      outputDb = threshold + (dB - threshold) / ratio
    }

    var x = ((dB + 60) / 60) * w
    var y = h - ((outputDb + 60) / 60) * h

    if (dB === -60) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()

  // Draw threshold marker
  var threshX = ((threshold + 60) / 60) * w
  ctx.strokeStyle = '#ff4757'
  ctx.lineWidth = 1
  ctx.setLineDash([2, 2])
  ctx.beginPath()
  ctx.moveTo(threshX, 0)
  ctx.lineTo(threshX, h)
  ctx.stroke()
  ctx.setLineDash([])

  // Draw current level indicator (dot on curve)
  if (analyser && analyserData && currentInputDb > -60) {
    var inputDb = currentInputDb
    var outputDb
    if (inputDb < threshold) {
      outputDb = inputDb
    } else {
      outputDb = threshold + (inputDb - threshold) / ratio
    }

    var dotX = ((inputDb + 60) / 60) * w
    var dotY = h - ((outputDb + 60) / 60) * h

    // Glow effect
    ctx.beginPath()
    ctx.arc(dotX, dotY, 8, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(46, 213, 115, 0.3)'
    ctx.fill()

    // Dot
    ctx.beginPath()
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2)
    ctx.fillStyle = '#2ed573'
    ctx.fill()

    // Show gain reduction if above threshold
    if (inputDb > threshold && ratio > 1) {
      var reduction = inputDb - outputDb
      ctx.fillStyle = '#ff4757'
      ctx.font = 'bold 10px sans-serif'
      ctx.fillText('-' + reduction.toFixed(1) + 'dB', dotX + 8, dotY - 4)
    }
  }

  // Labels
  ctx.fillStyle = '#888'
  ctx.font = '9px sans-serif'
  ctx.fillText('0dB', w - 20, 12)
  ctx.fillText('-60', 2, h - 4)
  ctx.fillStyle = '#ff4757'
  ctx.fillText(threshold + 'dB', threshX + 2, 12)
}

// ─── Level Meter Visualization ──────────────────────────────────────
function drawLevelMeter () {
  var w = levelMeterCanvas.width
  var h = levelMeterCanvas.height
  var ctx = levelMeterCtx

  // Clear
  ctx.fillStyle = '#252542'
  ctx.fillRect(0, 0, w, h)

  if (!analyser || !analyserData) {
    // Draw empty meter
    var emptyBarWidth = Math.min(30, w - 20)
    ctx.fillStyle = '#333'
    ctx.fillRect((w - emptyBarWidth) / 2, 10, emptyBarWidth, h - 20)
    return
  }

  // Get audio level
  analyser.getByteFrequencyData(analyserData)
  var sum = 0
  for (var i = 0; i < analyserData.length; i++) {
    sum += analyserData[i]
  }
  var avg = sum / analyserData.length
  var level = avg / 255 // 0-1

  // Convert to dB for compressor curve visualization (-60 to 0 range)
  // Add small epsilon to avoid log(0)
  currentInputDb = level > 0.001 ? 20 * Math.log10(level) : -60
  currentInputDb = Math.max(-60, Math.min(0, currentInputDb))

  // Draw meter background
  var barWidth = Math.min(30, w - 20)
  var barX = (w - barWidth) / 2
  ctx.fillStyle = '#333'
  ctx.fillRect(barX, 10, barWidth, h - 20)

  // Draw level bar
  var barHeight = level * (h - 20)
  var gradient = ctx.createLinearGradient(0, h - 10, 0, 10)
  gradient.addColorStop(0, '#2ed573')
  gradient.addColorStop(0.6, '#ffa502')
  gradient.addColorStop(1, '#ff4757')
  ctx.fillStyle = gradient
  ctx.fillRect(barX + 2, h - 10 - barHeight, barWidth - 4, barHeight)

  // Draw threshold line if compressor enabled
  if (compressorEnabledEl.checked) {
    var threshold = parseInt(compressorThresholdEl.value)
    var threshNorm = (threshold + 60) / 60 // -60 to 0 -> 0 to 1
    var threshY = h - 10 - threshNorm * (h - 20)
    ctx.strokeStyle = '#ff4757'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(barX - 5, threshY)
    ctx.lineTo(barX + barWidth + 5, threshY)
    ctx.stroke()
  }

}

// ─── Output Level Meter Visualization ────────────────────────────────
function drawMeter (canvas, ctx, analyserNode, analyserDataArray) {
  var w = canvas.width
  var h = canvas.height

  // Clear
  ctx.fillStyle = '#252542'
  ctx.fillRect(0, 0, w, h)

  if (!analyserNode || !analyserDataArray) {
    // Draw empty meter
    var emptyBarWidth = Math.min(30, w - 20)
    ctx.fillStyle = '#333'
    ctx.fillRect((w - emptyBarWidth) / 2, 10, emptyBarWidth, h - 20)
    return
  }

  // Get audio level
  analyserNode.getByteFrequencyData(analyserDataArray)
  var sum = 0
  for (var i = 0; i < analyserDataArray.length; i++) {
    sum += analyserDataArray[i]
  }
  var avg = sum / analyserDataArray.length
  var level = avg / 255 // 0-1

  // Draw meter background
  var barWidth = Math.min(30, w - 20)
  var barX = (w - barWidth) / 2
  ctx.fillStyle = '#333'
  ctx.fillRect(barX, 10, barWidth, h - 20)

  // Draw level bar (green gradient for output)
  var barHeight = level * (h - 20)
  var gradient = ctx.createLinearGradient(0, h - 10, 0, 10)
  gradient.addColorStop(0, '#2ed573')
  gradient.addColorStop(0.7, '#2ed573')
  gradient.addColorStop(1, '#ffa502')
  ctx.fillStyle = gradient
  ctx.fillRect(barX + 2, h - 10 - barHeight, barWidth - 4, barHeight)
}

function drawOutputMeter () {
  // Draw broadcaster output meter
  drawMeter(outputMeterCanvas, outputMeterCtx, outputAnalyser, outputAnalyserData)
  // Draw listener output meter (uses same analyser when in listener mode)
  drawMeter(listenerOutputMeterCanvas, listenerOutputMeterCtx, outputAnalyser, outputAnalyserData)
}

function startVisualization () {
  if (animationId) return

  function draw () {
    drawLevelMeter()
    drawOutputMeter()
    drawCompressorCurve() // Redraw to show current level on curve
    animationId = requestAnimationFrame(draw)
  }
  draw()
}

function stopVisualization () {
  if (animationId) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
  // Clear meters
  drawLevelMeter()
  drawOutputMeter()
}

// Initial curve draw
drawCompressorCurve()

// Set initial mode based on URL
if (isRoot) {
  modeBroadcaster.checked = true
  modeListener.checked = false
}

// Show/hide audio settings based on mode
var audioSettingsEl = document.getElementById('audio-settings')
var vadSettingsEl = document.getElementById('vad-settings')
var listenerSettingsEl = document.getElementById('listener-settings')

function updateSettingsVisibility () {
  var isBroadcaster = modeBroadcaster.checked
  audioSettingsEl.style.display = isBroadcaster ? 'block' : 'none'
  vadSettingsEl.style.display = isBroadcaster ? 'block' : 'none'
  listenerSettingsEl.style.display = isBroadcaster ? 'none' : 'block'
}

modeBroadcaster.onchange = updateSettingsVisibility
modeListener.onchange = updateSettingsVisibility
updateSettingsVisibility()

// Slider value display updates + real-time changes
inputGainEl.oninput = function () {
  var val = parseFloat(inputGainEl.value)
  inputGainValueEl.textContent = val.toFixed(1) + 'x'
  // Update live if broadcasting
  if (audio && audio._gainNode) {
    audio._gainNode.gain.value = val
    console.log('[audio] Gain =', val)
  }
}

compressorThresholdEl.oninput = function () {
  var val = parseInt(compressorThresholdEl.value)
  compressorThresholdValueEl.textContent = val + ' dB'
  drawCompressorCurve()
  // Update live if broadcasting
  if (audio && audio._compressorNode) {
    audio._compressorNode.threshold.value = val
  }
}

compressorRatioEl.oninput = function () {
  var val = parseInt(compressorRatioEl.value)
  compressorRatioValueEl.textContent = val + ':1'
  drawCompressorCurve()
  // Update live if broadcasting and compressor enabled
  if (audio && audio._compressorNode && compressorEnabledEl.checked) {
    audio._compressorNode.ratio.value = val
  }
}

// Toggle handlers for live enable/disable
var compressorControlsEl = document.getElementById('compressor-controls')
var compressorCurveBoxEl = compressorCurveCanvas.parentElement

compressorEnabledEl.onchange = function () {
  var enabled = compressorEnabledEl.checked
  // Show/hide compressor controls and curve
  compressorControlsEl.style.display = enabled ? 'block' : 'none'
  compressorCurveBoxEl.style.display = enabled ? 'flex' : 'none'

  if (audio && audio._compressorNode) {
    // ratio=1 effectively bypasses compressor
    audio._compressorNode.ratio.value = enabled
      ? parseInt(compressorRatioEl.value)
      : 1
    console.log('[audio] Compressor', enabled ? 'ON' : 'OFF', 'ratio=' + audio._compressorNode.ratio.value)
  }
  drawCompressorCurve()
}

// Initialize compressor controls visibility
compressorControlsEl.style.display = compressorEnabledEl.checked ? 'block' : 'none'
compressorCurveBoxEl.style.display = compressorEnabledEl.checked ? 'flex' : 'none'

vadEnabledEl.onchange = function () {
  // VAD is in the worklet - send message to update
  vadThresholdEl.disabled = !vadEnabledEl.checked
  if (audio && audio._workletNode) {
    audio._workletNode.port.postMessage({
      type: 'config',
      vadEnabled: vadEnabledEl.checked
    })
  }
}

vadThresholdEl.oninput = function () {
  var val = parseFloat(vadThresholdEl.value)
  // Map 0.005-0.05 to sensitivity labels (lower threshold = more sensitive)
  var label
  if (val <= 0.01) label = 'High'
  else if (val <= 0.02) label = 'Medium'
  else if (val <= 0.035) label = 'Low'
  else label = 'Very Low'
  vadThresholdValueEl.textContent = label

  if (audio && audio._workletNode) {
    audio._workletNode.port.postMessage({
      type: 'config',
      vadThreshold: val
    })
  }
}

// Initialize VAD threshold disabled state based on VAD enabled
vadThresholdEl.disabled = !vadEnabledEl.checked

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
      var opts = {
        vadEnabled: vadEnabledEl.checked,
        vadThreshold: parseFloat(vadThresholdEl.value),
        compressor: compressorEnabledEl.checked,
        compressorThreshold: parseInt(compressorThresholdEl.value),
        compressorRatio: parseInt(compressorRatioEl.value),
        inputGain: parseFloat(inputGainEl.value)
      }
      console.log('[audio] Broadcaster options:', opts)
      audio = new AudioBroadcaster(node, opts)

      audio.on('speaking', function () {
        vadSpan.textContent = 'Speaking'
        document.getElementById('vad-indicator').classList.add('active')
      })

      audio.on('silent', function () {
        vadSpan.textContent = 'Silent'
        document.getElementById('vad-indicator').classList.remove('active')
      })

      await audio.start()

      // Set up analysers for level meter visualization
      if (audio._audioContext && audio._gainNode) {
        // Input analyser (after gain, before compressor)
        analyser = audio._audioContext.createAnalyser()
        analyser.fftSize = 256
        analyserData = new Uint8Array(analyser.frequencyBinCount)
        audio._gainNode.connect(analyser)

        // Output analyser (after compressor)
        outputAnalyser = audio._audioContext.createAnalyser()
        outputAnalyser.fftSize = 256
        outputAnalyserData = new Uint8Array(outputAnalyser.frequencyBinCount)
        audio._compressorNode.connect(outputAnalyser)

        startVisualization()
      }

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

      // Set up analyser for listener output meter
      if (audio._audioContext && audio._workletNode) {
        outputAnalyser = audio._audioContext.createAnalyser()
        outputAnalyser.fftSize = 256
        outputAnalyserData = new Uint8Array(outputAnalyser.frequencyBinCount)
        audio._workletNode.connect(outputAnalyser)
        startVisualization()
      }

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
  stopVisualization()
  analyser = null
  analyserData = null
  outputAnalyser = null
  outputAnalyserData = null

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
