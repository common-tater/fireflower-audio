module.exports = AudioChannelManager

var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')

inherits(AudioChannelManager, EventEmitter)

// Drop frames if channel buffer exceeds this (prevents latency buildup)
var AUDIO_BACKPRESSURE_THRESHOLD = 200

/**
 * AudioChannelManager - Manages _audio data channels on fireflower peers
 *
 * Creates unreliable/unordered data channels for low-latency audio on each peer.
 * Handles relay logic: forwards audio from upstream to all downstream peers.
 *
 * @param {Object} node - fireflower Node instance
 * @param {Object} opts - Options
 * @param {boolean} opts.relay - Whether to relay audio to downstream (default: true)
 */
function AudioChannelManager (node, opts) {
  if (!(this instanceof AudioChannelManager)) return new AudioChannelManager(node, opts)
  EventEmitter.call(this)

  opts = opts || {}
  this.node = node
  this.relay = opts.relay !== false
  this._started = false
  this._boundHandlers = {}
}

/**
 * Start managing audio channels on all peer connections
 */
AudioChannelManager.prototype.start = function () {
  if (this._started) return
  this._started = true

  var self = this

  // Wire existing upstream
  if (this.node.upstream && this.node.upstream.didConnect) {
    this._wireUpstream(this.node.upstream)
  }

  // Wire existing downstream peers
  for (var id in this.node.downstream) {
    var peer = this.node.downstream[id]
    if (peer.didConnect) {
      this._wireDownstream(peer)
    }
  }

  // Handle new upstream connections (for non-root nodes)
  this._boundHandlers.connect = function () {
    if (self.node.upstream) {
      self._wireUpstream(self.node.upstream)
    }
  }
  this.node.on('connect', this._boundHandlers.connect)

  // Handle new downstream connections (create channel before SDP negotiation)
  this._boundHandlers.peerCreated = function (peer) {
    self._wireDownstream(peer)
  }
  this.node.on('peerCreated', this._boundHandlers.peerCreated)

  // Handle incoming custom channels (for upstream audio)
  this._boundHandlers.datachannel = function (peer, channel) {
    if (channel.label === '_audio') {
      self._wireIncomingAudioChannel(peer, channel)
    }
  }
  this.node.on('datachannel', this._boundHandlers.datachannel)

  // Handle peer disconnections
  this._boundHandlers.peerdisconnect = function (peer) {
    // Clean up _audio reference
    if (peer._audio) {
      peer._audio = null
    }
  }
  this.node.on('peerdisconnect', this._boundHandlers.peerdisconnect)
}

/**
 * Stop managing audio channels
 */
AudioChannelManager.prototype.stop = function () {
  if (!this._started) return
  this._started = false

  // Remove event listeners
  if (this._boundHandlers.connect) {
    this.node.removeListener('connect', this._boundHandlers.connect)
  }
  if (this._boundHandlers.peerCreated) {
    this.node.removeListener('peerCreated', this._boundHandlers.peerCreated)
  }
  if (this._boundHandlers.datachannel) {
    this.node.removeListener('datachannel', this._boundHandlers.datachannel)
  }
  if (this._boundHandlers.peerdisconnect) {
    this.node.removeListener('peerdisconnect', this._boundHandlers.peerdisconnect)
  }
  this._boundHandlers = {}
}

/**
 * Wire audio channel on upstream peer (receiving side)
 * Called on node connect when upstream already has _audio channel
 */
AudioChannelManager.prototype._wireUpstream = function (peer) {
  var self = this

  // Check if _audio already exists (channel may have been created before we started)
  if (peer._audio && peer._audio.readyState === 'open') {
    peer._audio.onmessage = function (evt) {
      self._onAudioData(peer, evt.data)
    }
  }
}

/**
 * Wire incoming audio channel from node's datachannel event
 */
AudioChannelManager.prototype._wireIncomingAudioChannel = function (peer, channel) {
  var self = this
  peer._audio = channel
  channel.onmessage = function (evt) {
    self._onAudioData(peer, evt.data)
  }
}

/**
 * Wire audio channel on downstream peer (sending side)
 */
AudioChannelManager.prototype._wireDownstream = function (peer) {
  var self = this

  // Create the audio channel with unreliable/unordered config
  // Note: ordered=false only works on P2P (SCTP), server transport is TCP underneath
  peer._audio = peer.createDataChannel('_audio', {
    ordered: false,
    maxRetransmits: 0
  })

  peer._audio.onopen = function () {
    self.emit('channel:open', peer)
  }

  peer._audio.onclose = function () {
    peer._audio = null
  }
}

/**
 * Handle incoming audio data from upstream
 */
AudioChannelManager.prototype._onAudioData = function (fromPeer, data) {
  // Emit for local playback
  this.emit('audio', data, fromPeer)

  // Relay to downstream if enabled
  if (this.relay) {
    this._relayToDownstream(data)
  }
}

/**
 * Relay audio data to all downstream peers
 */
AudioChannelManager.prototype._relayToDownstream = function (data) {
  for (var id in this.node.downstream) {
    var peer = this.node.downstream[id]
    this._sendToPeer(peer, data)
  }
}

/**
 * Send audio data to a specific peer (with backpressure check)
 */
AudioChannelManager.prototype._sendToPeer = function (peer, data) {
  if (!peer._audio) return
  if (peer._audio.readyState !== 'open') return

  // Drop if buffer is building up (old audio is toxic)
  if (peer._audio.bufferedAmount > AUDIO_BACKPRESSURE_THRESHOLD) {
    this.emit('drop', peer)
    return
  }

  try {
    peer._audio.send(data)
  } catch (err) {
    // Send failed, channel may be closing
  }
}

/**
 * Send audio data to all downstream peers (for broadcaster use)
 */
AudioChannelManager.prototype.broadcast = function (data) {
  this._relayToDownstream(data)
}
