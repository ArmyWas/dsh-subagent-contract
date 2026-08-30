function directChildId(params) {
  return typeof params.childSessionId === 'string' && params.childSessionId.length > 0
    ? params.childSessionId
    : null
}

function requireKnownSender(state, event, kind) {
  const sender = event?.data?.source?.senderSessionId
  if (typeof sender !== 'string' || !state.children.has(sender)) {
    throw new Error(`${kind} notification did not identify a direct child`)
  }
}

export function freshState() {
  return {
    serial: 0,
    children: new Map(),
    started: 0,
    finished: 0,
    openActivations: 0,
    settlements: 0,
    reports: 0,
    sendCalls: 0,
    modelRequests: 0,
    rootStatus: 'unknown',
    rootIdleAt: -1,
    lastFinishedAt: -1,
    lastSettlementAt: -1,
    lastReportAt: -1,
    methods: new Map(),
  }
}

export function observe(state, rootSessionId, notification, expected) {
  state.serial += 1
  if (state.serial > expected.maxNotifications) throw new Error('notification count exceeded the fixed scenario safety limit')
  state.methods.set(notification.method, (state.methods.get(notification.method) ?? 0) + 1)
  const params = notification.params ?? {}

  if (notification.method === 'session.event' && params.event?.type === 'request/header') {
    const maxTokens = params.event?.data?.header?.config?.maxTokens
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > expected.maxTokens) {
      throw new Error(`request maxTokens exceeded or omitted the fixed ${expected.maxTokens}-token safety limit`)
    }
    state.modelRequests += 1
    if (state.modelRequests > expected.maxRequests) throw new Error('model request count exceeded the fixed scenario safety limit')
  }

  if (notification.method === 'subagent.started') {
    if (params.parentSessionId !== rootSessionId) {
      if (state.children.has(params.parentSessionId)) throw new Error('nested subagent activation is outside this fixed matrix')
      return
    }
    const childSessionId = directChildId(params)
    if (childSessionId === null) throw new Error('subagent.started omitted childSessionId')
    const child = state.children.get(childSessionId) ?? { started: 0, finished: 0, open: 0 }
    child.started += 1
    child.open += 1
    state.children.set(childSessionId, child)
    state.started += 1
    state.openActivations += 1
    if (state.children.size > expected.uniqueChildren || child.started > expected.activationsPerChild) {
      throw new Error('subagent.started exceeded the fixed lifecycle cardinality')
    }
    return
  }

  if (notification.method === 'subagent.finished') {
    if (params.parentSessionId !== rootSessionId) {
      if (state.children.has(params.parentSessionId)) throw new Error('nested subagent completion is outside this fixed matrix')
      return
    }
    const childSessionId = directChildId(params)
    const child = childSessionId === null ? undefined : state.children.get(childSessionId)
    if (child === undefined || child.open < 1) throw new Error('subagent.finished has no matching open child activation')
    if (params.provider !== 'spawn' || params.status !== 'ok' || params.stopReason !== 'completed') {
      throw new Error('subagent.finished reported a non-successful fixed-matrix activation')
    }
    child.finished += 1
    child.open -= 1
    state.finished += 1
    state.openActivations -= 1
    state.lastFinishedAt = state.serial
    return
  }

  if (notification.method === 'session.status' && params.sessionId === rootSessionId) {
    state.rootStatus = params.status
    if (params.status === 'idle') state.rootIdleAt = state.serial
    return
  }

  if (notification.method !== 'session.event' || params.sessionId !== rootSessionId) return
  const event = params.event
  if (event?.type === 'tool/call' && event?.data?.name === 'send_message') {
    state.sendCalls += 1
    if (state.sendCalls > expected.sendCalls) throw new Error('send_message exceeded the fixed scenario cardinality')
  }
  if (event?.type !== 'user/message') return
  if (event?.data?.source?.kind === 'subagent-settled') {
    requireKnownSender(state, event, 'settlement')
    state.settlements += 1
    state.lastSettlementAt = state.serial
    if (state.settlements > expected.settlements) throw new Error('settlement count exceeded the fixed scenario cardinality')
  }
  if (event?.data?.source?.kind === 'subagent-report') {
    requireKnownSender(state, event, 'report')
    state.reports += 1
    state.lastReportAt = state.serial
    if (state.reports > expected.reports) throw new Error('report count exceeded the fixed scenario cardinality')
  }
}

export function lifecycleComplete(state, expected) {
  if (state.children.size !== expected.uniqueChildren || state.openActivations !== 0) return false
  if (state.started !== expected.uniqueChildren * expected.activationsPerChild || state.finished !== state.started) return false
  for (const child of state.children.values()) {
    if (child.started !== expected.activationsPerChild || child.finished !== child.started || child.open !== 0) return false
  }
  if (state.settlements !== expected.settlements || state.reports !== expected.reports || state.sendCalls !== expected.sendCalls) return false
  const lastBoundary = Math.max(state.lastFinishedAt, state.lastSettlementAt, state.lastReportAt)
  return state.rootStatus === 'idle' && state.rootIdleAt > lastBoundary
}
