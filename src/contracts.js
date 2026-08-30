import { BUNDLED_CASE_IDS, CONTRACT_IDS, diagnostic } from './diagnostics.js'
import { contentText, messageText, toolArguments, toolResult } from './session-log.js'

const SUPPORTED_DESCRIPTOR_VERSIONS = new Set([2, 3])

function byType(session, type) {
  return session.ownEvents.filter(event => event?.type === type)
}

function descriptorOf(session) {
  return byType(session, 'subagent/descriptor')[0]?.data
}

function childrenOf(sessionId, sessions) {
  return sessions.filter(session => session.header.origin === 'subagent' && session.header.parentSession === sessionId)
}

function toolCalls(session, name) {
  return byType(session, 'tool/call').filter(event => event?.data?.name === name)
}

function resultIndex(session) {
  const index = new Map()
  for (const event of byType(session, 'tool/result')) {
    const result = toolResult(event)
    if (result.callId === undefined) continue
    const bucket = index.get(result.callId) ?? []
    bucket.push({ event, ...result })
    index.set(result.callId, bucket)
  }
  return index
}

function lastTurnReason(session) {
  return byType(session, 'turn/end').at(-1)?.data?.reason?.kind
}

function finalAssistantText(session) {
  return messageText(byType(session, 'assistant/message').at(-1))
}

function hasOpenActivity(session) {
  return byType(session, 'turn/start').length > byType(session, 'turn/end').length
    || byType(session, 'step/start').length > byType(session, 'step/end').length
}

function normalizeText(value) {
  return value.replace(/\r\n/gu, '\n').trim()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value, key) {
  return value[key] === undefined || typeof value[key] === 'string'
}

function stringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function descriptorShapeError(value) {
  if (!isRecord(value)) return 'payload is not an object'
  if (!SUPPORTED_DESCRIPTOR_VERSIONS.has(value.version)) return undefined
  if (value.mode !== 'one-shot' && value.mode !== 'continuable') return 'mode must be one-shot or continuable'
  if (typeof value.provider !== 'string' || value.provider === '') return 'provider must be a non-empty string'
  const common = new Set(['version', 'mode', 'provider', 'label'])
  const continuable = new Set([
    ...common,
    'agentProvider',
    'agentModel',
    ...(value.version === 3 ? ['agentReasoningEffort'] : []),
    'persona',
    'toolFilter',
  ])
  const allowed = value.mode === 'one-shot' ? common : continuable
  const unknown = Object.keys(value).find(key => !allowed.has(key))
  if (unknown !== undefined) return `unknown field ${JSON.stringify(unknown)} for descriptor v${value.version}`
  if (!optionalString(value, 'label')) return 'label must be a string when present'
  if (value.mode === 'continuable' && (typeof value.label !== 'string' || value.label === '')) return 'continuable label must be a non-empty string'
  for (const key of ['agentProvider', 'agentModel', 'agentReasoningEffort', 'persona']) {
    if (!optionalString(value, key)) return `${key} must be a string when present`
  }
  if (value.toolFilter !== undefined) {
    if (!isRecord(value.toolFilter)) return 'toolFilter must be an object'
    const toolKeys = Object.keys(value.toolFilter)
    if (toolKeys.length === 0 || toolKeys.some(key => key !== 'allow' && key !== 'deny')) return 'toolFilter must declare only allow and/or deny'
    if (value.toolFilter.allow !== undefined && !stringArray(value.toolFilter.allow)) return 'toolFilter.allow must be an array of strings'
    if (value.toolFilter.deny !== undefined && !stringArray(value.toolFilter.deny)) return 'toolFilter.deny must be an array of strings'
  }
  return undefined
}

function context(trial, sessionId) {
  return { caseId: trial.caseId, trial: trial.trial, ...(sessionId ? { sessionId } : {}) }
}

function checkLineage(trial, diagnostics) {
  const { sessions } = trial
  const ids = new Map()
  for (const session of sessions) {
    const id = session.header.id
    if (ids.has(id)) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.lineage, 'C01_DUPLICATE_SESSION_ID', `duplicate session id ${id}`, context(trial, id)))
    }
    ids.set(id, session)
  }
  const roots = sessions.filter(session => session.header.origin !== 'subagent')
  if (roots.length !== 1) {
    diagnostics.push(diagnostic('violation', CONTRACT_IDS.lineage, 'C01_ROOT_CARDINALITY', `expected exactly one root session, found ${roots.length}`, context(trial)))
  }
  for (const child of sessions.filter(session => session.header.origin === 'subagent')) {
    const id = child.header.id
    const parentId = child.header.parentSession
    if (typeof parentId !== 'string') {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.lineage, 'C01_PARENT_MISSING', `child ${id} has no parentSession`, context(trial, id)))
      continue
    }
    const parent = ids.get(parentId)
    if (parent === undefined) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.lineage, 'C01_PARENT_UNRESOLVED', `child ${id} points to missing parent ${parentId}`, context(trial, id)))
      continue
    }
    const expected = parent.header.delegationDepth + 1
    if (child.header.delegationDepth !== expected) {
      diagnostics.push(diagnostic(
        'violation',
        CONTRACT_IDS.lineage,
        'C01_DEPTH_MISMATCH',
        `child=${id} depth=${child.header.delegationDepth} parent=${parentId} depth=${parent.header.delegationDepth} expected=${expected}`,
        context(trial, id),
      ))
    }
    const visited = new Set([id])
    let cursor = parent
    while (cursor !== undefined) {
      if (visited.has(cursor.header.id)) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.lineage, 'C01_LINEAGE_CYCLE', `lineage cycle reaches ${cursor.header.id}`, context(trial, id)))
        break
      }
      visited.add(cursor.header.id)
      cursor = typeof cursor.header.parentSession === 'string' ? ids.get(cursor.header.parentSession) : undefined
    }
  }
}

function checkDescriptors(trial, diagnostics, compatibility) {
  for (const child of trial.sessions.filter(session => session.header.origin === 'subagent')) {
    const descriptors = byType(child, 'subagent/descriptor')
    if (descriptors.length !== 1) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.descriptor, 'C02_DESCRIPTOR_CARDINALITY', `child ${child.header.id} has ${descriptors.length} own descriptors; expected 1`, context(trial, child.header.id)))
      continue
    }
    const descriptor = descriptors[0].data
    if (!SUPPORTED_DESCRIPTOR_VERSIONS.has(descriptor?.version)) {
      compatibility.push(diagnostic('compatibility', CONTRACT_IDS.descriptor, 'C02_UNSUPPORTED_DESCRIPTOR_VERSION', `child ${child.header.id} uses unsupported descriptor version ${String(descriptor?.version)}`, context(trial, child.header.id)))
      continue
    }
    const shapeError = descriptorShapeError(descriptor)
    if (shapeError !== undefined) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.descriptor, 'C02_DESCRIPTOR_SHAPE', `child ${child.header.id} descriptor is invalid: ${shapeError}`, context(trial, child.header.id)))
    }
    const descriptorIndex = child.ownEvents.indexOf(descriptors[0])
    const requestIndex = child.ownEvents.findIndex(event => event?.type === 'request/header')
    if (requestIndex !== -1 && descriptorIndex > requestIndex) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.descriptor, 'C02_DESCRIPTOR_LATE', `child ${child.header.id} descriptor appears after its first request/header`, context(trial, child.header.id)))
    }
  }
}

function correlateSubagentCalls(parent, sessions) {
  const results = resultIndex(parent)
  const children = childrenOf(parent.header.id, sessions)
  return toolCalls(parent, 'subagent').map(call => {
    const args = toolArguments(call)
    const callId = call?.data?.callId
    const callResults = typeof callId === 'string' ? results.get(callId) ?? [] : []
    const description = typeof args?.description === 'string' ? args.description : undefined
    const matches = description === undefined ? [] : children.filter(child => descriptorOf(child)?.label === description)
    return { call, callId, args, callResults, description, matches }
  })
}

function explicitLaunchMode(item) {
  if (item.args?.run_in_background === true) return 'background'
  if (item.args?.run_in_background === false) return 'foreground'
  return undefined
}

function observationsForTrial(trial, scenarioStatus) {
  const calls = trial.sessions.flatMap(session => byType(session, 'tool/call'))
  const messages = trial.sessions.flatMap(session => byType(session, 'user/message'))
  const launches = trial.sessions.flatMap(session => correlateSubagentCalls(session, trial.sessions))
  return {
    caseId: trial.caseId,
    trial: trial.trial,
    sessions: trial.sessions.length,
    roots: trial.sessions.filter(session => session.header.origin !== 'subagent').length,
    children: trial.sessions.filter(session => session.header.origin === 'subagent').length,
    subagentCalls: calls.filter(event => event?.data?.name === 'subagent').length,
    foregroundCalls: launches.filter(item => explicitLaunchMode(item) === 'foreground').length,
    backgroundCalls: launches.filter(item => explicitLaunchMode(item) === 'background').length,
    sendMessageCalls: calls.filter(event => event?.data?.name === 'send_message').length,
    reportCalls: calls.filter(event => event?.data?.name === 'report').length,
    settlementNotices: messages.filter(event => event?.data?.source?.kind === 'subagent-settled').length,
    reportRelays: messages.filter(event => event?.data?.source?.kind === 'subagent-report').length,
    scenarioStatus,
  }
}

function scenarioGap(trial, compatibility, message) {
  compatibility.push(diagnostic(
    'compatibility',
    CONTRACT_IDS.scenario,
    'S00_SCENARIO_NOT_EXERCISED',
    message,
    context(trial),
  ))
}

function completeLaunch(item) {
  return item.callResults.length === 1 && !item.callResults[0].isError && item.matches.length === 1
}

function checkScenarioCoverage(trial, compatibility) {
  if (!BUNDLED_CASE_IDS.includes(trial.caseId)) return 'not-applicable'
  const root = trial.sessions.find(session => session.header.origin !== 'subagent')
  if (root === undefined) {
    scenarioGap(trial, compatibility, `${trial.caseId} has no root session to inspect`)
    return 'not-exercised'
  }
  const launches = correlateSubagentCalls(root, trial.sessions)
  const rootCompleted = lastTurnReason(root) === 'completed'
  const childCount = trial.sessions.filter(session => session.header.origin === 'subagent').length
  if (trial.caseId === 'foreground-success') {
    const launch = launches[0]
    if (launches.length !== 1 || explicitLaunchMode(launch) !== 'foreground'
      || launch.description !== 'contract:foreground-success' || !completeLaunch(launch) || childCount !== 1 || !rootCompleted) {
      scenarioGap(trial, compatibility, 'foreground-success did not complete its one required foreground launch')
      return 'not-exercised'
    }
    return 'exercised'
  }
  if (trial.caseId === 'two-admissions') {
    const descriptions = launches.map(item => item.description).sort()
    const firstTurn = launches[0]?.call?.data?.turn
    const firstStep = launches[0]?.call?.data?.step
    const secondTurn = launches[1]?.call?.data?.turn
    const secondStep = launches[1]?.call?.data?.step
    const sameStep = Number.isSafeInteger(firstTurn) && Number.isSafeInteger(firstStep)
      && Number.isSafeInteger(secondTurn) && Number.isSafeInteger(secondStep)
      && firstTurn === secondTurn && firstStep === secondStep
    const exercised = launches.length === 2
      && launches.every(item => explicitLaunchMode(item) === 'foreground' && completeLaunch(item))
      && JSON.stringify(descriptions) === JSON.stringify(['contract:admission-a', 'contract:admission-b'])
      && childCount === 2 && sameStep && rootCompleted
    if (!exercised) {
      scenarioGap(trial, compatibility, 'two-admissions did not complete two distinct foreground launches in one model step')
      return 'not-exercised'
    }
    return 'exercised'
  }
  if (trial.caseId === 'continuable-fifo') {
    const launch = launches[0]
    if (launches.length !== 1 || explicitLaunchMode(launch) !== 'background'
      || launch.description !== 'contract:continuable-fifo' || !completeLaunch(launch) || childCount !== 1) {
      scenarioGap(trial, compatibility, 'continuable-fifo did not complete its required background launch')
      return 'not-exercised'
    }
    const child = launch.matches[0]
    const results = resultIndex(root)
    const sends = toolCalls(root, 'send_message').map(call => ({
      args: toolArguments(call),
      results: results.get(call?.data?.callId) ?? [],
    }))
    const exercised = sends.length === 2
      && sends.every(send => send.args?.subagent_id === child.header.id && send.results.length === 1 && !send.results[0].isError)
      && JSON.stringify(sends.map(send => send.args?.message)) === JSON.stringify(['FIRST', 'SECOND'])
    const notices = byType(root, 'user/message').filter(event => event?.data?.source?.kind === 'subagent-settled'
      && event?.data?.source?.senderSessionId === child.header.id)
    const sendCalls = toolCalls(root, 'send_message')
    const orderedBoundaries = notices.length === 3 && sendCalls.length === 2
      && root.ownEvents.indexOf(notices[0]) < root.ownEvents.indexOf(sendCalls[0])
      && root.ownEvents.indexOf(sendCalls[0]) < root.ownEvents.indexOf(notices[1])
      && root.ownEvents.indexOf(notices[1]) < root.ownEvents.indexOf(sendCalls[1])
      && root.ownEvents.indexOf(sendCalls[1]) < root.ownEvents.indexOf(notices[2])
    const childEvents = child.ownEvents
    const starts = byType(child, 'turn/start')
    const ends = byType(child, 'turn/end')
    const coordinator = byType(child, 'user/message').filter(event => event?.data?.source?.kind === 'coordinator')
    const closedInOrder = starts.length === 3 && ends.length === 3 && coordinator.length === 2
      && ends.every(event => event?.data?.reason?.kind === 'completed')
      && childEvents.indexOf(starts[0]) < childEvents.indexOf(ends[0])
      && childEvents.indexOf(ends[0]) < childEvents.indexOf(starts[1])
      && childEvents.indexOf(starts[1]) < childEvents.indexOf(coordinator[0])
      && childEvents.indexOf(coordinator[0]) < childEvents.indexOf(ends[1])
      && childEvents.indexOf(ends[1]) < childEvents.indexOf(starts[2])
      && childEvents.indexOf(starts[2]) < childEvents.indexOf(coordinator[1])
      && childEvents.indexOf(coordinator[1]) < childEvents.indexOf(ends[2])
    if (!exercised || !orderedBoundaries || !closedInOrder || !rootCompleted) {
      scenarioGap(trial, compatibility, 'continuable-fifo did not exercise settle -> FIRST -> settle -> SECOND -> settle on one child')
      return 'not-exercised'
    }
    return 'exercised'
  }
  if (trial.caseId === 'continuable-report') {
    const launch = launches[0]
    if (launches.length !== 1 || explicitLaunchMode(launch) !== 'background'
      || launch.description !== 'contract:continuable-report' || !completeLaunch(launch) || childCount !== 1) {
      scenarioGap(trial, compatibility, 'continuable-report did not complete its required background launch')
      return 'not-exercised'
    }
    const child = launch.matches[0]
    const results = resultIndex(child)
    const allReports = toolCalls(child, 'report')
    const parentSends = toolCalls(root, 'send_message')
    const reports = allReports.filter(call => {
      const matches = results.get(call?.data?.callId) ?? []
      return matches.length === 1 && !matches[0].isError && toolArguments(call)?.output === 'CONTRACT-REPORT-OK'
    })
    if (allReports.length !== 1 || reports.length !== 1 || parentSends.length !== 0) {
      scenarioGap(trial, compatibility, 'continuable-report did not issue exactly one successful fixed-token report without a parent follow-up')
      return 'not-exercised'
    }
    const starts = byType(child, 'turn/start')
    const ends = byType(child, 'turn/end')
    const childEvents = child.ownEvents
    const reportIndex = childEvents.indexOf(allReports[0])
    const enclosingStart = [...starts].reverse().find(event => childEvents.indexOf(event) < reportIndex)
    const enclosingEnd = ends.find(event => childEvents.indexOf(event) > reportIndex)
    const closedReportTurn = enclosingStart !== undefined && enclosingEnd !== undefined
      && enclosingEnd?.data?.reason?.kind === 'completed'
    if (!closedReportTurn || !rootCompleted) {
      scenarioGap(trial, compatibility, 'continuable-report did not persist one completed child turn and a completed root turn')
      return 'not-exercised'
    }
    return 'exercised'
  }
  return 'not-applicable'
}

function checkAdmission(trial, diagnostics, compatibility) {
  for (const parent of trial.sessions) {
    const correlations = correlateSubagentCalls(parent, trial.sessions)
    const callIdCounts = new Map()
    for (const item of correlations) {
      if (typeof item.callId === 'string') callIdCounts.set(item.callId, (callIdCounts.get(item.callId) ?? 0) + 1)
    }
    const duplicateCallIds = new Set([...callIdCounts].filter(([, count]) => count > 1).map(([callId]) => callId))
    for (const callId of duplicateCallIds) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.admission, 'C03_DUPLICATE_CALL_ID', `parent ${parent.header.id} reuses subagent call id ${callId}`, context(trial, parent.header.id)))
    }
    const descriptionCounts = new Map()
    for (const item of correlations) {
      if (item.description !== undefined) {
        descriptionCounts.set(item.description, (descriptionCounts.get(item.description) ?? 0) + 1)
      }
    }
    const ambiguousDescriptions = new Set([...descriptionCounts].filter(([, count]) => count > 1).map(([description]) => description))
    for (const description of ambiguousDescriptions) {
      compatibility.push(diagnostic(
        'compatibility',
        CONTRACT_IDS.admission,
        'C03_CORRELATION_AMBIGUOUS',
        `parent ${parent.header.id} reuses one subagent description; durable children cannot be correlated reliably`,
        context(trial, parent.header.id),
      ))
    }
    const admitted = new Set()
    const uncorrelatableDescriptions = new Set(ambiguousDescriptions)
    const unsupportedChildIds = new Set()
    for (const item of correlations) {
      if (typeof item.callId !== 'string') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.admission, 'C03_CALL_ID_MISSING', 'subagent tool/call has no callId', context(trial, parent.header.id)))
        continue
      }
      if (duplicateCallIds.has(item.callId)) continue
      if (item.callResults.length !== 1) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.admission, 'C03_RESULT_CARDINALITY', `subagent call ${item.callId} has ${item.callResults.length} tool results; expected 1`, context(trial, parent.header.id)))
        continue
      }
      if (item.description === undefined) {
        compatibility.push(diagnostic('compatibility', CONTRACT_IDS.admission, 'C03_DESCRIPTION_UNUSABLE', `subagent call ${item.callId} has no parseable description, so durable correlation is unavailable`, context(trial, parent.header.id)))
        continue
      }
      if (ambiguousDescriptions.has(item.description)) continue
      const unsupported = item.matches.some(child => descriptorOf(child)?.provider !== 'spawn')
      if (unsupported) {
        for (const child of item.matches.filter(value => descriptorOf(value)?.provider !== 'spawn')) unsupportedChildIds.add(child.header.id)
        uncorrelatableDescriptions.add(item.description)
        compatibility.push(diagnostic('compatibility', CONTRACT_IDS.admission, 'C03_PROVIDER_UNSUPPORTED', `subagent call ${item.callId} resolved to a non-session-backed provider`, context(trial, parent.header.id)))
        continue
      }
      const mode = explicitLaunchMode(item)
      if (mode === undefined) {
        uncorrelatableDescriptions.add(item.description)
        compatibility.push(diagnostic('compatibility', CONTRACT_IDS.admission, 'C03_MODE_UNSPECIFIED', `subagent call ${item.callId} does not persist an explicit run_in_background mode`, context(trial, parent.header.id)))
        continue
      }
      const background = mode === 'background'
      const failed = item.callResults[0].isError
      const validCount = background === true
        ? item.matches.length === (failed ? 0 : 1)
        : failed
          ? item.matches.length === 0 || item.matches.length === 1
          : item.matches.length === 1
      if (!validCount) {
        const expected = background === false && failed ? '0 or 1' : String(failed ? 0 : 1)
        diagnostics.push(diagnostic(
          'violation',
          CONTRACT_IDS.admission,
          background === true && failed ? 'C03_GHOST_CHILD' : 'C03_CHILD_CARDINALITY',
          `subagent call ${item.callId} has ${item.matches.length} matching child sessions; expected ${expected}`,
          context(trial, parent.header.id),
        ))
        continue
      }
      for (const child of item.matches) admitted.add(child.header.id)
    }
    for (const child of childrenOf(parent.header.id, trial.sessions)) {
      const descriptor = descriptorOf(child)
      if (descriptor?.provider !== 'spawn') {
        if (!unsupportedChildIds.has(child.header.id)) {
          compatibility.push(diagnostic('compatibility', CONTRACT_IDS.admission, 'C03_PROVIDER_UNSUPPORTED', `direct child ${child.header.id} uses a provider this contract cannot correlate`, context(trial, child.header.id)))
        }
        continue
      }
      if (uncorrelatableDescriptions.has(descriptor?.label)) continue
      if (!admitted.has(child.header.id)) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.admission, 'C03_UNACCOUNTED_CHILD', `child ${child.header.id} has no successful parent subagent call`, context(trial, child.header.id)))
      }
    }
  }
}

function checkForeground(trial, diagnostics, compatibility, unsettledSessionIds) {
  for (const parent of trial.sessions) {
    for (const item of correlateSubagentCalls(parent, trial.sessions)) {
      if (explicitLaunchMode(item) !== 'foreground' || item.callResults.length !== 1 || item.matches.length !== 1) continue
      const child = item.matches[0]
      const result = item.callResults[0]
      const reason = lastTurnReason(child)
      const output = finalAssistantText(child)
      if (reason === undefined) {
        if (!unsettledSessionIds.has(child.header.id)) {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.foreground, 'C04_TERMINAL_MISSING', `foreground child ${child.header.id} has no own turn/end`, context(trial, child.header.id)))
        }
      } else if (!result.isError && reason === 'completed') {
        if (normalizeText(result.text) !== normalizeText(output)) {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.foreground, 'C04_OUTPUT_MISMATCH', `parent tool result does not equal child ${child.header.id} final output`, context(trial, child.header.id)))
        }
      } else if (!result.isError) {
        if (reason !== 'completed') {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.foreground, 'C04_FAILURE_MARKED_SUCCESS', `child ${child.header.id} ended ${reason} but parent tool result is not an error`, context(trial, child.header.id)))
        }
      } else if (reason === 'completed') {
        compatibility.push(diagnostic(
          'compatibility',
          CONTRACT_IDS.foreground,
          'C04_COMPLETED_ERROR_AMBIGUOUS',
          `completed child ${child.header.id} has an error parent result; durable logs cannot distinguish cleanup failure from outcome mapping failure`,
          context(trial, child.header.id),
        ))
      } else {
        if (output !== '' && !result.text.includes(output)) {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.foreground, 'C04_PARTIAL_OUTPUT_LOST', `child ${child.header.id} partial output is absent from parent error result`, context(trial, child.header.id)))
        }
      }
    }
  }
}

function checkContinuation(trial, diagnostics, unsettledSessionIds) {
  for (const parent of trial.sessions) {
    const parentResults = resultIndex(parent)
    const sends = toolCalls(parent, 'send_message').map(call => ({
      call,
      args: toolArguments(call),
      results: parentResults.get(call?.data?.callId) ?? [],
    }))
    const sendCallIdCounts = new Map()
    for (const send of sends) {
      const callId = send.call?.data?.callId
      if (typeof callId === 'string') sendCallIdCounts.set(callId, (sendCallIdCounts.get(callId) ?? 0) + 1)
    }
    for (const [callId, count] of sendCallIdCounts) {
      if (count > 1) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_DUPLICATE_CALL_ID', `parent ${parent.header.id} reuses send_message call id ${callId}`, context(trial, parent.header.id)))
      }
    }
    for (const item of correlateSubagentCalls(parent, trial.sessions)) {
      if (explicitLaunchMode(item) !== 'background' || item.callResults.length !== 1 || item.matches.length !== 1) continue
      const child = item.matches[0]
      const descriptor = descriptorOf(child)
      if (descriptor?.mode !== 'continuable') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_MODE_MISMATCH', `background child ${child.header.id} descriptor mode is ${String(descriptor?.mode)}`, context(trial, child.header.id)))
      }
      if (!item.callResults[0].text.includes(child.header.id)) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_START_ID_MISMATCH', `background start result does not name child ${child.header.id}`, context(trial, child.header.id)))
      }
      const directed = sends.filter(send => send.args?.subagent_id === child.header.id)
      for (const send of directed) {
        if (send.results.length !== 1) {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_RESULT_CARDINALITY', `send_message ${send.call?.data?.callId ?? '<missing>'} has ${send.results.length} tool results; expected 1`, context(trial, parent.header.id)))
        }
      }
      const accepted = directed.filter(send => send.results.length === 1 && !send.results[0].isError)
      const expectedMessages = accepted.map(send => send.args?.message).filter(value => typeof value === 'string')
      const coordinatorMessages = byType(child, 'user/message').filter(event => event?.data?.source?.kind === 'coordinator')
      const actualMessages = coordinatorMessages.map(messageText)
      const sendersValid = coordinatorMessages.every(event => event?.data?.source?.form === 'relay' && event?.data?.source?.senderSessionId === parent.header.id)
      if (!sendersValid) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_SENDER_MISMATCH', `child ${child.header.id} has a coordinator message with wrong parent provenance`, context(trial, child.header.id)))
      }
      if (JSON.stringify(actualMessages) !== JSON.stringify(expectedMessages)) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_FIFO_MISMATCH', `child ${child.header.id} coordinator messages do not match successful send_message order`, context(trial, child.header.id)))
      }
      const turns = byType(child, 'turn/start').length
      if (!unsettledSessionIds.has(child.header.id) && turns < 1 + expectedMessages.length) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_TURN_COUNT', `child ${child.header.id} has ${turns} turns for ${expectedMessages.length} follow-ups`, context(trial, child.header.id)))
      }
      const terminals = byType(child, 'turn/end').length
      if (!unsettledSessionIds.has(child.header.id) && terminals < 1 + expectedMessages.length) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.continuation, 'C05_TERMINAL_COUNT', `child ${child.header.id} has ${terminals} terminal records for ${expectedMessages.length} follow-ups`, context(trial, child.header.id)))
      }
    }
  }
}

function checkSettlement(trial, diagnostics, scenarioStatus) {
  const byId = new Map(trial.sessions.map(session => [session.header.id, session]))
  for (const parent of trial.sessions) {
    const notices = byType(parent, 'user/message').filter(event => event?.data?.source?.kind === 'subagent-settled')
    const messageIds = new Set()
    for (const notice of notices) {
      const sender = notice.data?.source?.senderSessionId
      const child = typeof sender === 'string' ? byId.get(sender) : undefined
      if (child === undefined || child.header.parentSession !== parent.header.id || descriptorOf(child)?.mode !== 'continuable') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.settlement, 'C06_SENDER_UNRESOLVED', `settlement notice in parent ${parent.header.id} does not resolve to a direct continuable child`, context(trial, parent.header.id)))
      }
      if (notice.data?.source?.form !== 'notice' || typeof notice.data?.source?.summary !== 'string' || notice.data.source.summary === '') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.settlement, 'C06_NOTICE_SHAPE', `settlement notice in parent ${parent.header.id} has invalid source metadata`, context(trial, parent.header.id)))
      }
      const messageId = notice.data?.id
      if (typeof messageId !== 'string' || messageId === '') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.settlement, 'C06_NOTICE_SHAPE', `settlement notice in parent ${parent.header.id} has no durable message id`, context(trial, parent.header.id)))
      } else {
        if (messageIds.has(messageId)) {
          diagnostics.push(diagnostic('violation', CONTRACT_IDS.settlement, 'C06_DUPLICATE_NOTICE_ID', `parent ${parent.header.id} repeats settlement message id ${messageId}`, context(trial, parent.header.id)))
        }
        messageIds.add(messageId)
      }
    }
  }

  if (scenarioStatus !== 'exercised' || (trial.caseId !== 'continuable-fifo' && trial.caseId !== 'continuable-report')) return
  for (const child of trial.sessions.filter(session => descriptorOf(session)?.mode === 'continuable')) {
    const parent = byId.get(child.header.parentSession)
    if (parent === undefined) continue
    const notices = byType(parent, 'user/message').filter(event => event?.data?.source?.kind === 'subagent-settled' && event?.data?.source?.senderSessionId === child.header.id)
    const results = resultIndex(parent)
    const successfulSends = toolCalls(parent, 'send_message').filter(call => {
      const args = toolArguments(call)
      const matches = results.get(call?.data?.callId) ?? []
      return args?.subagent_id === child.header.id && matches.length === 1 && !matches[0].isError
    }).length
    const expected = trial.caseId === 'continuable-fifo' ? 1 + successfulSends : 1
    if (notices.length !== expected) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.settlement, 'C06_SCENARIO_NOTICE_CARDINALITY', `fixed scenario expected ${expected} settlement boundaries for child ${child.header.id}, found ${notices.length}`, context(trial, child.header.id)))
    }
  }
}

function reportMessageId(text) {
  return text.match(/\bas message ([0-9a-f-]{36})\b/iu)?.[1]
}

function reportRelayPayload(relay) {
  const blocks = relay?.data?.content
  return Array.isArray(blocks) ? contentText(blocks.slice(1)) : ''
}

function checkReports(trial, diagnostics, compatibility, scenarioStatus) {
  const byId = new Map(trial.sessions.map(session => [session.header.id, session]))
  for (const parent of trial.sessions) {
    for (const relay of byType(parent, 'user/message').filter(event => event?.data?.source?.kind === 'subagent-report')) {
      const sender = relay.data?.source?.senderSessionId
      const child = typeof sender === 'string' ? byId.get(sender) : undefined
      if (child === undefined || child.header.parentSession !== parent.header.id || descriptorOf(child)?.mode !== 'continuable') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_SENDER_UNRESOLVED', `report relay in parent ${parent.header.id} does not resolve to a direct continuable child`, context(trial, parent.header.id)))
      }
    }
  }
  for (const child of trial.sessions.filter(session => session.header.origin === 'subagent')) {
    const parent = trial.sessions.find(session => session.header.id === child.header.parentSession)
    if (parent === undefined) continue
    const childResults = resultIndex(child)
    const calls = toolCalls(child, 'report')
    const relays = byType(parent, 'user/message').filter(event => event?.data?.source?.kind === 'subagent-report' && event?.data?.source?.senderSessionId === child.header.id)
    const accountedRelayIds = new Set()
    let failedReports = 0
    for (const call of calls) {
      const results = childResults.get(call?.data?.callId) ?? []
      if (results.length !== 1) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_RESULT_CARDINALITY', `report ${call?.data?.callId ?? '<missing>'} has ${results.length} tool results; expected 1`, context(trial, child.header.id)))
        continue
      }
      if (results[0].isError) {
        failedReports += 1
        continue
      }
      const output = toolArguments(call)?.output
      if (typeof output !== 'string') {
        compatibility.push(diagnostic('compatibility', CONTRACT_IDS.report, 'C07_OUTPUT_UNUSABLE', `successful report ${call?.data?.callId ?? '<missing>'} has no string output argument`, context(trial, child.header.id)))
        continue
      }
      const messageId = reportMessageId(results[0].text)
      if (messageId === undefined) {
        compatibility.push(diagnostic('compatibility', CONTRACT_IDS.report, 'C07_RESULT_PROTOCOL_UNSUPPORTED', `successful report ${call?.data?.callId ?? '<missing>'} does not expose the accepted message id`, context(trial, child.header.id)))
        continue
      }
      const matches = relays.filter(relay => relay?.data?.id === messageId)
      if (matches.length !== 1) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_REPORT_CARDINALITY', `successful report ${call?.data?.callId ?? '<missing>'} resolves to ${matches.length} parent relays; expected 1`, context(trial, child.header.id)))
        continue
      }
      const relay = matches[0]
      accountedRelayIds.add(messageId)
      if (normalizeText(reportRelayPayload(relay)) !== normalizeText(output)) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_REPORT_CONTENT_MISMATCH', `child ${child.header.id} report relay does not preserve the reported output`, context(trial, child.header.id)))
      }
    }
    for (const relay of relays) {
      if (relay.data?.source?.form !== 'relay') {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_REPORT_SHAPE', `child ${child.header.id} report message is not a relay`, context(trial, child.header.id)))
      }
    }
    const unaccountedRelays = relays.filter(relay => !accountedRelayIds.has(relay?.data?.id))
    if (unaccountedRelays.length > failedReports) {
      diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_UNACCOUNTED_RELAY', `child ${child.header.id} has ${unaccountedRelays.length} relays that cannot be explained by successful or possibly post-delivery failed reports`, context(trial, child.header.id)))
    }
    if (scenarioStatus === 'exercised' && trial.caseId === 'continuable-report' && accountedRelayIds.size === 1) {
      const relay = relays.find(event => accountedRelayIds.has(event?.data?.id))
      const reportIndex = parent.ownEvents.indexOf(relay)
      const hasLaterSettlement = parent.ownEvents.some((event, index) => index > reportIndex && event?.type === 'user/message' && event?.data?.source?.kind === 'subagent-settled' && event?.data?.source?.senderSessionId === child.header.id)
      if (!hasLaterSettlement) {
        diagnostics.push(diagnostic('violation', CONTRACT_IDS.report, 'C07_REPORT_NOT_FOLLOWED_BY_SETTLEMENT', `fixed report scenario has no later settlement for child ${child.header.id}`, context(trial, child.header.id)))
      }
    }
  }
}

/** Verify all seven durable, cross-session subagent contracts for one trial. */
export function verifyTrial(trial) {
  const violations = []
  const compatibility = []
  const incomplete = trial.sessions.filter(session => session.incomplete)
  if (incomplete.length > 0) {
    compatibility.push(diagnostic(
      'compatibility',
      'RUN_ARTIFACT',
      'RUN_TRACE_INCOMPLETE',
      `trial contains ${incomplete.length} crash-truncated trace logs`,
      context(trial),
    ))
  }
  const unsettled = trial.sessions.filter(hasOpenActivity)
  const unsettledSessionIds = new Set(unsettled.map(session => session.header.id))
  for (const session of unsettled) {
    compatibility.push(diagnostic(
      'compatibility',
      'RUN_ARTIFACT',
      'RUN_TRACE_UNSETTLED',
      `session ${session.header.id} ends with an open turn or step; terminal-dependent checks are inconclusive`,
      context(trial, session.header.id),
    ))
  }
  const scenarioStatus = checkScenarioCoverage(trial, compatibility)
  checkLineage(trial, violations)
  checkDescriptors(trial, violations, compatibility)
  checkAdmission(trial, violations, compatibility)
  checkForeground(trial, violations, compatibility, unsettledSessionIds)
  checkContinuation(trial, violations, unsettledSessionIds)
  checkSettlement(trial, violations, scenarioStatus)
  checkReports(trial, violations, compatibility, scenarioStatus)
  return { violations, compatibility, coverage: observationsForTrial(trial, scenarioStatus) }
}

export { CONTRACT_IDS, SUPPORTED_DESCRIPTOR_VERSIONS }
