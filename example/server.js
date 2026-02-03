#!/usr/bin/env node

/**
 * Simple HTTP server for fireflower-audio example
 */

var http = require('http')
var fs = require('fs')
var path = require('path')

var PORT = process.env.PORT || 8085

var mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript'
}

var server = http.createServer(function (req, res) {
  console.log('[example]', req.method, req.url)

  var url = req.url.split('?')[0]
  if (url === '/') url = '/index.html'

  var filePath = path.join(__dirname, url)

  // Also serve worklet files from src/worklets
  if (url.includes('/worklets/')) {
    filePath = path.join(__dirname, '..', 'src', 'worklets', path.basename(url))
  }

  var ext = path.extname(filePath)
  var contentType = mimeTypes[ext] || 'text/plain'

  fs.readFile(filePath, function (err, data) {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404)
        res.end('Not found: ' + url)
      } else {
        res.writeHead(500)
        res.end('Error: ' + err.message)
      }
      return
    }

    res.writeHead(200, { 'Content-Type': contentType })
    res.end(data)
  })
})

server.listen(PORT, function () {
  console.log('Fireflower Audio Example')
  console.log('========================')
  console.log('Server running on http://localhost:' + PORT)
  console.log()
  console.log('Open these URLs in different browser tabs:')
  console.log('  Root (broadcaster): http://localhost:' + PORT + '/?root=true')
  console.log('  Listener:           http://localhost:' + PORT + '/')
  console.log()
})
