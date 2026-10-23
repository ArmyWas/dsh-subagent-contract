import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import sharp from 'sharp'

// Floors prevent the reviewed lock from silently reintroducing known issues.
// They are not a substitute for a fresh advisory scan or a reachability review.
const floors = {
  '@modelcontextprotocol/sdk': '1.32.0',
  'proxy-addr': '2.0.8',
  compression: '1.8.2',
  hono: '4.13.11',
  'ip-address': '10.7.4',
  sharp: '0.35.5',
}

function stableParts(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'security floor requires a stable version')
  return version.split('.').map(Number)
}

for (const [name, floor] of Object.entries(floors)) {
  test(`installed ${name} meets the reviewed security floor`, async () => {
    const metadata = JSON.parse(await readFile(new URL(`node_modules/${name}/package.json`, import.meta.url), 'utf8'))
    const installed = stableParts(metadata.version)
    const minimum = stableParts(floor)
    const firstDifference = installed.findIndex((value, index) => value !== minimum[index])
    assert.ok(firstDifference === -1 || installed[firstDifference] > minimum[firstDifference], `${name} is below ${floor}`)
  })
}

test('patched sharp and its platform binary render a bounded synthetic SVG', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="white"/></svg>')
  const { data, info } = await sharp(svg, { limitInputPixels: 4 }).png().toBuffer({ resolveWithObject: true })
  assert.equal(info.format, 'png')
  assert.equal(info.width, 2)
  assert.equal(info.height, 2)
  assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
})

for (const status of [307, 308]) {
  test(`HTTP transport refuses cross-origin ${status} without forwarding fixture data`, async () => {
    const calls = []
    const source = new URL('https://source.invalid/mcp')
    const transport = new StreamableHTTPClientTransport(source, {
      requestInit: { headers: { 'X-API-Key': 'synthetic-fixture-only' } },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init })
        return new Response(null, { status, headers: { location: 'https://other.invalid/mcp' } })
      },
    })
    try {
      await transport.start()
      await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /Redirect .* not followed/u)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, source.href)
      assert.equal(calls[0].init.redirect, 'manual')
      assert.equal(new Headers(calls[0].init.headers).get('X-API-Key'), 'synthetic-fixture-only')
    } finally {
      await transport.close()
    }
  })
}

test('HTTP transport still follows a same-origin 307', async () => {
  const calls = []
  const transport = new StreamableHTTPClientTransport(new URL('https://source.invalid/mcp'), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      return calls.length === 1
        ? new Response(null, { status: 307, headers: { location: '/final' } })
        : new Response(null, { status: 202 })
    },
  })
  try {
    await transport.start()
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })
    assert.deepEqual(calls.map(call => call.url), ['https://source.invalid/mcp', 'https://source.invalid/final'])
    assert.ok(calls.every(call => call.init.redirect === 'manual'))
  } finally {
    await transport.close()
  }
})

const expectedResource = new URL('https://contract.invalid/mcp')

async function exerciseBearer(resource, { configured = true, expired = false } = {}) {
  const state = { nextCalls: 0, status: undefined, body: undefined }
  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async () => ({
        token: 'synthetic-fixture-only',
        clientId: 'fixture-client',
        scopes: [],
        expiresAt: expired ? 1 : Number.MAX_SAFE_INTEGER,
        ...(resource === undefined ? {} : { resource }),
      }),
    },
    ...(configured ? { expectedResource } : {}),
  })
  const response = {
    set() { return this },
    status(value) { state.status = value; return this },
    json(value) { state.body = value; return this },
  }
  await middleware({ headers: { authorization: 'Bearer synthetic-fixture-only' } }, response, () => { state.nextCalls++ })
  return state
}

test('bearer audience check rejects a token issued for another resource', async () => {
  const result = await exerciseBearer(new URL('https://other.invalid/mcp'))
  assert.equal(result.nextCalls, 0)
  assert.equal(result.status, 401)
  assert.equal(result.body.error, 'invalid_token')
})

test('bearer audience check rejects missing resource metadata', async () => {
  const result = await exerciseBearer(undefined)
  assert.equal(result.nextCalls, 0)
  assert.equal(result.status, 401)
})

test('bearer audience check accepts the configured resource', async () => {
  const result = await exerciseBearer(expectedResource)
  assert.equal(result.nextCalls, 1)
  assert.equal(result.status, undefined)
})

test('bearer check still rejects an expired token for the correct resource', async () => {
  const result = await exerciseBearer(expectedResource, { expired: true })
  assert.equal(result.nextCalls, 0)
  assert.equal(result.status, 401)
})

test('upgrading alone does not enable the optional bearer audience check', async () => {
  const result = await exerciseBearer(new URL('https://other.invalid/mcp'), { configured: false })
  assert.equal(result.nextCalls, 1)
})

test('offline initialization guard blocks fetch, HTTP, TCP, and listeners including ESM imports', () => {
  const guard = fileURLToPath(new URL('offline-network-guard.cjs', import.meta.url))
  const fixture = `
    import assert from 'node:assert/strict'
    import { request as httpRequest, get as httpGet } from 'node:http'
    import { request as httpsRequest, get as httpsGet } from 'node:https'
    import { connect, createConnection, Socket, Server } from 'node:net'
    assert.equal(globalThis[Symbol.for('dsh-subagent-contract.offline-smoke')], true)
    for (const operation of [
      () => fetch('https://fixture.invalid/'),
      () => httpRequest('http://127.0.0.1:1/'),
      () => httpGet('http://127.0.0.1:1/'),
      () => httpsRequest('https://127.0.0.1:1/'),
      () => httpsGet('https://127.0.0.1:1/'),
      () => connect({ host: '127.0.0.1', port: 1 }),
      () => createConnection({ host: '127.0.0.1', port: 1 }),
      () => new Socket().connect({ host: '127.0.0.1', port: 1 }),
      () => new Server().listen(0, '127.0.0.1'),
    ]) assert.throws(operation, /SDK smoke test forbids network access/u)
  `
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  const result = spawnSync(process.execPath, ['--require', guard, '--input-type=module', '--eval', fixture], {
    env, encoding: 'utf8', timeout: 10_000,
  })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
})
