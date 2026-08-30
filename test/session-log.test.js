import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import test from 'node:test'
import { decodeSessionBuffer, loadSessionLog, messageText, parseSessionLog, scanZstdFrames } from '../src/session-log.js'

const header = '{"type":"session","version":0,"id":"s","createdAt":1,"cwd":"/x","delegationDepth":0}\n'
const event = '{"type":"turn/end","seq":1,"time":1,"data":{"reason":{"kind":"completed"}}}\n'

test('reads plain JSONL and keeps the own suffix', () => {
  const session = parseSessionLog(header + event)
  assert.equal(session.header.id, 's')
  assert.equal(session.ownEvents.length, 1)
})

test('rejects unknown session header protocol versions', () => {
  assert.throws(() => parseSessionLog(header.replace('"version":0', '"version":99') + event), /unsupported session header version 99/u)
})

test('decodes concatenated DSH-style zstd frames', () => {
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const encoded = Buffer.concat([
    zstdCompressSync(Buffer.from(header), options),
    zstdCompressSync(Buffer.from(event), options),
  ])
  assert.equal(scanZstdFrames(encoded).frames.length, 2)
  assert.equal(decodeSessionBuffer(encoded), header + event)
})

test('reads both direct user content and nested assistant message content', () => {
  assert.equal(messageText({ data: { content: [{ type: 'text', text: 'user' }] } }), 'user')
  assert.equal(messageText({ data: { message: { content: [{ type: 'text', text: 'assistant' }] } } }), 'assistant')
})

test('uses header seedLength to exclude an inherited fork prefix', () => {
  const seededHeader = '{"type":"session","version":0,"id":"fork","createdAt":1,"cwd":"/x","delegationDepth":1,"seedLength":1}\n'
  const inherited = '{"type":"subagent/descriptor","seq":1,"time":1,"data":{"version":2,"mode":"continuable","provider":"spawn","label":"ancestor"}}\n'
  const own = '{"type":"subagent/descriptor","seq":2,"time":2,"data":{"version":3,"mode":"continuable","provider":"spawn","label":"own"}}\n'
  const session = parseSessionLog(seededHeader + inherited + own)
  assert.equal(session.ownEvents.length, 1)
  assert.equal(session.ownEvents[0].data.label, 'own')
})

test('accepts seedLength equal to the persisted event count', () => {
  const seededHeader = '{"type":"session","version":0,"id":"fork","createdAt":1,"cwd":"/x","delegationDepth":1,"seedLength":1}\n'
  const session = parseSessionLog(seededHeader + event)
  assert.deepEqual(session.ownEvents, [])
})

test('rejects invalid or out-of-range seedLength values', () => {
  for (const value of ['-1', '1.5', '"1"', '9007199254740992']) {
    const seededHeader = `{"type":"session","version":0,"id":"fork","createdAt":1,"cwd":"/x","delegationDepth":1,"seedLength":${value}}\n`
    assert.throws(() => parseSessionLog(seededHeader + event), /invalid seedLength/u)
  }
  const tooLarge = '{"type":"session","version":0,"id":"fork","createdAt":1,"cwd":"/x","delegationDepth":1,"seedLength":2}\n'
  assert.throws(() => parseSessionLog(tooLarge + event), /seedLength exceeds/u)
})

test('marks a crash-truncated final JSONL row as incomplete', () => {
  const session = parseSessionLog(header + event + '{"type":"turn/start"')
  assert.equal(session.incomplete, true)
  assert.equal(session.events.length, 1)
})

test('keeps complete zstd frames but marks a torn final frame incomplete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subagent-contract-zstd-'))
  const path = join(directory, 'session.jsonl.zstd')
  const first = zstdCompressSync(Buffer.from(header))
  const second = zstdCompressSync(Buffer.from(event))
  await writeFile(path, Buffer.concat([first, second.subarray(0, second.length - 5)]))
  const session = await loadSessionLog(path)
  assert.equal(session.header.id, 's')
  assert.equal(session.incomplete, true)
})

test('rejects a zstd session with no complete frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subagent-contract-zstd-empty-'))
  const path = join(directory, 'session.jsonl.zstd')
  const frame = zstdCompressSync(Buffer.from(header))
  await writeFile(path, frame.subarray(0, 5))
  await assert.rejects(loadSessionLog(path), /no complete frames/u)
})
