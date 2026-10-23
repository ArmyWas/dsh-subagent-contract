// Initialization smoke tests must never contact a provider or open a listener.
// This is a Node-level test guard, not an operating-system security sandbox.
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const { syncBuiltinESMExports } = require('node:module')

function denyNetwork() {
  throw new Error('SDK smoke test forbids network access')
}

globalThis.fetch = denyNetwork
http.request = http.get = denyNetwork
https.request = https.get = denyNetwork
net.connect = net.createConnection = denyNetwork
net.Socket.prototype.connect = denyNetwork
net.Server.prototype.listen = denyNetwork
syncBuiltinESMExports()
Object.defineProperty(globalThis, Symbol.for('dsh-subagent-contract.offline-smoke'), { value: true })
