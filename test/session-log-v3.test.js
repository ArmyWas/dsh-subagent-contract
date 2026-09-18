import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadSessionLog, parseSessionLog } from '../src/session-log.js'

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-format-v3')

async function fixture(name) {
  return readFile(join(fixtureRoot, name), 'utf8')
}

function v3Header(fields = {}) {
  return JSON.stringify({
    type: 'session',
    version: 3,
    id: 'v3-test',
    createdAt: 1,
    cwd: 'C:\\fixture',
    delegationDepth: 0,
    isSeeded: false,
    ...fields,
  })
}

function row(value) {
  return `${JSON.stringify(value)}\n`
}

function invalidV3(text) {
  assert.throws(
    () => parseSessionLog(text),
    error => error instanceof Error
      && /invalid v3 session log/u.test(error.message)
      && !/TOP-SECRET-PAYLOAD/u.test(error.message),
  )
}

test('restores an unseeded physical v3 log and preserves its physical header', async () => {
  const session = parseSessionLog(await fixture('unseeded.jsonl'))
  assert.equal(session.header.type, 'session')
  assert.equal(session.header.version, 3)
  assert.equal(session.header.isSeeded, false)
  assert.equal(session.header.cwd, 'C:\\fixture')
  assert.equal(session.inheritedEventCount, 0)
  assert.equal(session.events[0].seq, 0)
  assert.deepEqual(session.ownEvents, session.events)
})

test('uses the last inherited end-seed marker as the v3 cut and keeps the marker in the own suffix', async () => {
  const session = await loadSessionLog(join(fixtureRoot, 'seeded.jsonl'))
  assert.equal(session.header.isSeeded, true)
  assert.equal(session.inheritedEventCount, 2)
  assert.deepEqual(session.events.map(event => event.seq), [0, 1, 2])
  assert.deepEqual(session.ownEvents.map(event => event.seq), [2])
  assert.equal(session.ownEvents[0].type, 'session/end-seed')
  assert.equal(session.ownEvents[0].data.inherited, true)
})

test('expands physical sourceEventSeqs ranges during v3 recovery', async () => {
  const session = parseSessionLog(await fixture('source-ranges.jsonl'))
  assert.deepEqual(session.events[2].sourceEventSeqs, [0, 1])
  assert.deepEqual(session.events[2].surfaceOp, { op: 'replace', startSeq: 0, endSeq: 1 })
})

test('rejects missing or contradictory v3 seed metadata', () => {
  invalidV3(`${v3Header({ isSeeded: undefined })}\n`)
  invalidV3(`${v3Header({ isSeeded: true, parentSession: 'parent', origin: 'subagent', delegationDepth: 1 })}\n`)
  invalidV3(`${v3Header()}\n${row({ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } })}`)
})

test('requires inherited seed markers to use the exact boolean true value', () => {
  for (const inherited of [false, 0, 'true', null, {}]) {
    invalidV3(`${v3Header()}\n${row({ type: 'session/end-seed', seq: 0, time: 1, data: { inherited } })}`)
  }

  const seeded = v3Header({
    isSeeded: true,
    parentSession: 'parent',
    origin: 'subagent',
    delegationDepth: 1,
  })
  const validMarker = row({ type: 'session/end-seed', seq: 0, time: 1, data: { inherited: true } })
  const falseMarker = row({ type: 'session/end-seed', seq: 1, time: 2, data: { inherited: false } })
  invalidV3(`${seeded}\n${validMarker}${falseMarker}`)
})

test('rejects unknown session versions without routing them through v3 recovery', () => {
  assert.throws(
    () => parseSessionLog(`${v3Header({ version: 4 })}\n`),
    /unsupported session header version 4/u,
  )
})

test('rejects v3 sequence gaps and duplicates', () => {
  const endSeed = seq => row({ type: 'session/end-seed', seq, time: seq + 1, data: {} })
  invalidV3(`${v3Header()}\n${endSeed(1)}`)
  invalidV3(`${v3Header()}\n${endSeed(0)}${endSeed(0)}`)
})

test('rejects sourceEventSeqs that cite the current or a later event', () => {
  const first = row({
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'safe' }], role: 'user', id: 'first' },
  })
  const invalid = row({
    type: 'user/message',
    seq: 1,
    time: 2,
    surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 },
    sourceEventSeqs: [[0, 1]],
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'safe' }], role: 'user', id: 'second' },
  })
  invalidV3(`${v3Header()}\n${first}${invalid}`)
})

test('rejects duplicate and out-of-order physical sourceEventSeqs ranges', () => {
  const message = (seq, id, sourceEventSeqs) => row({
    type: 'user/message',
    seq,
    time: seq + 1,
    surfaceOp: 'append',
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'safe' }], role: 'user', id },
  })
  const prefix = `${v3Header()}\n${message(0, 'first')}${message(1, 'second')}`
  invalidV3(`${prefix}${message(2, 'duplicate', [[0, 1], [1, 1]])}`)
  invalidV3(`${prefix}${message(2, 'out-of-order', [[1, 1], [0, 0]])}`)
})

test('bounds cumulative sourceEventSeqs expansion before catalog recovery', () => {
  // This exact 1,500-row shape restores successfully with the pinned catalog;
  // only this package's cumulative 1,048,576-entry safety budget rejects it.
  const rows = []
  for (let seq = 0; seq < 1_500; seq += 1) {
    rows.push(row({
      type: 'user/message',
      seq,
      time: seq + 1,
      surfaceOp: 'append',
      ...(seq === 0 ? {} : { sourceEventSeqs: [[0, seq - 1]] }),
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'bounded' }],
        role: 'user',
        id: `bounded-${seq}`,
      },
    }))
  }
  invalidV3(`${v3Header()}\n${rows.join('')}`)
})

test('rejects unknown required events and inconsistent turn references', () => {
  invalidV3(`${v3Header()}\n${row({ type: 'future/required', seq: 0, time: 1, data: {} })}`)
  invalidV3(`${v3Header()}\n${row({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })}${row({
    type: 'turn/end',
    seq: 1,
    time: 2,
    data: { turn: 2, reason: { kind: 'completed' } },
  })}`)
})

test('does not fall back to a permissive parser for semantically damaged v3 rows', () => {
  const damaged = row({
    type: 'user/message',
    seq: 0,
    time: 1,
    surfaceOp: 'append',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'TOP-SECRET-PAYLOAD' }],
      role: 'invalid-role',
      id: 'damaged',
    },
  })
  invalidV3(`${v3Header()}\n${damaged}`)
})

test('marks only a torn final JSON row incomplete and still rejects a complete invalid row', () => {
  const prefix = `${v3Header()}\n${row({ type: 'session/end-seed', seq: 0, time: 1, data: {} })}`
  const truncated = parseSessionLog(`${prefix}{"type":"user/message","seq":1`)
  assert.equal(truncated.incomplete, true)
  assert.equal(truncated.events.length, 1)

  invalidV3(`${prefix}${row({ type: 'session/end-seed', seq: 2, time: 2, data: {} })}`)

  assert.throws(
    () => parseSessionLog(`${prefix}{"type":"user/message","seq":1\n`),
    /invalid JSON/u,
  )
})

test('does not treat arbitrary invalid tokens without a trailing newline as a torn JSON object', () => {
  const prefix = `${v3Header()}\n`
  for (const invalidTail of ['{"broken":]', 'nullx']) {
    assert.throws(() => parseSessionLog(`${prefix}${invalidTail}`), /invalid JSON/u)
  }
})
