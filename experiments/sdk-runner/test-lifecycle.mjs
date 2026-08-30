import assert from 'node:assert/strict'
import test from 'node:test'
import { freshState, lifecycleComplete, observe } from './lifecycle.mjs'

const root = 'root'
const fifo = { uniqueChildren: 1, activationsPerChild: 3, settlements: 3, reports: 0, sendCalls: 2, maxRequests: 16, maxNotifications: 32_768, maxTokens: 4_096 }
const started = childSessionId => ({ method: 'subagent.started', params: { parentSessionId: root, childSessionId } })
const finished = childSessionId => ({ method: 'subagent.finished', params: { parentSessionId: root, childSessionId, provider: 'spawn', status: 'ok', stopReason: 'completed' } })
const event = value => ({ method: 'session.event', params: { sessionId: root, event: value } })
const notice = (kind, senderSessionId) => event({ type: 'user/message', data: { source: { kind, senderSessionId } } })
const send = () => event({ type: 'tool/call', data: { name: 'send_message' } })

test('pairs every FIFO activation by child id and waits for final root idle', () => {
  const state = freshState()
  for (let index = 0; index < 3; index += 1) {
    observe(state, root, started('child'), fifo)
    observe(state, root, finished('child'), fifo)
    observe(state, root, notice('subagent-settled', 'child'), fifo)
    if (index < 2) observe(state, root, send(), fifo)
  }
  observe(state, root, { method: 'session.status', params: { sessionId: root, status: 'idle' } }, fifo)
  assert.equal(lifecycleComplete(state, fifo), true)
})

test('rejects an unpaired or unsuccessful child completion', () => {
  const state = freshState()
  assert.throws(() => observe(state, root, finished('wrong-child'), fifo), /no matching open child activation/u)
  observe(state, root, started('child'), fifo)
  assert.throws(
    () => observe(state, root, { method: 'subagent.finished', params: { parentSessionId: root, childSessionId: 'child', provider: 'spawn', status: 'error', stopReason: 'error' } }, fifo),
    /non-successful/u,
  )
})

test('rejects nested or excess child activation', () => {
  const state = freshState()
  observe(state, root, started('child'), fifo)
  assert.throws(
    () => observe(state, root, { method: 'subagent.started', params: { parentSessionId: 'child', childSessionId: 'grandchild' } }, fifo),
    /nested subagent/u,
  )
  observe(state, root, started('child'), fifo)
  observe(state, root, started('child'), fifo)
  assert.throws(() => observe(state, root, started('child'), fifo), /exceeded/u)
})

test('does not accept an earlier idle state after the root becomes running again', () => {
  const expected = { uniqueChildren: 1, activationsPerChild: 1, settlements: 0, reports: 0, sendCalls: 0, maxRequests: 6, maxNotifications: 4_096, maxTokens: 4_096 }
  const state = freshState()
  observe(state, root, started('child'), expected)
  observe(state, root, finished('child'), expected)
  observe(state, root, { method: 'session.status', params: { sessionId: root, status: 'idle' } }, expected)
  observe(state, root, { method: 'session.status', params: { sessionId: root, status: 'running' } }, expected)
  assert.equal(lifecycleComplete(state, expected), false)
})

test('bounds model requests and total notifications per case', () => {
  const expected = { uniqueChildren: 1, activationsPerChild: 1, settlements: 0, reports: 0, sendCalls: 0, maxRequests: 1, maxNotifications: 2, maxTokens: 4_096 }
  const request = event({ type: 'request/header', data: { header: { config: { maxTokens: 4_096 } } } })
  const state = freshState()
  observe(state, root, request, expected)
  assert.throws(() => observe(state, root, request, expected), /model request count exceeded/u)

  const notificationState = freshState()
  observe(notificationState, root, { method: 'unknown', params: {} }, expected)
  observe(notificationState, root, { method: 'unknown', params: {} }, expected)
  assert.throws(() => observe(notificationState, root, { method: 'unknown', params: {} }, expected), /notification count exceeded/u)
})

test('rejects missing or oversized request token caps', () => {
  const expected = { ...fifo, maxRequests: 3 }
  const state = freshState()
  const request = maxTokens => event({ type: 'request/header', data: { header: { config: { maxTokens } } } })
  observe(state, root, request(4_096), expected)
  assert.throws(() => observe(state, root, request(256_000), expected), /token safety limit/u)
  assert.throws(() => observe(freshState(), root, event({ type: 'request/header', data: {} }), expected), /token safety limit/u)
})
