import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { loadSessionLog } from '../../src/session-log.js'
import { verifyTrial } from '../../src/contracts.js'
import { freshState, lifecycleComplete, observe } from './lifecycle.mjs'
import { publicDeepSeekEnvironment } from './runner-environment.mjs'
import {
  RUNNER_FAILURE,
  classifyRunnerFailure,
  failureFromOfflineVerification,
  publicFailure,
  runnerFailure,
} from './runner-policy.mjs'

const CASE_TIMEOUT_MS = 300_000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_TRACE_PATHS = 16
const MAX_TRACE_BYTES = 64 * 1024 * 1024
const MAX_CASE_TRACE_BYTES = 128 * 1024 * 1024
const MAX_NOTIFICATIONS_PER_CASE = 32_768
const MAX_CASE_ATTEMPTS = 3
const MAX_OUTPUT_TOKENS = 4_096
const PUBLIC_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const experimentRoot = dirname(fileURLToPath(import.meta.url))
const activeClients = new Set()
const closePromises = new Map()
const shutdownCleanupFailures = []
const runnerAbort = new AbortController()
let requestedSignal

function interruptionError() {
  return runnerFailure(RUNNER_FAILURE.INTERRUPTED, {
    publicSummary: requestedSignal?.name,
  })
}

function throwIfInterrupted() {
  if (runnerAbort.signal.aborted) throw interruptionError()
}

async function withInterruption(start) {
  throwIfInterrupted()
  const promise = start()
  let rejectInterrupted
  const interrupted = new Promise((_, reject) => {
    rejectInterrupted = () => reject(interruptionError())
    runnerAbort.signal.addEventListener('abort', rejectInterrupted, { once: true })
  })
  try {
    return await Promise.race([promise, interrupted])
  } finally {
    runnerAbort.signal.removeEventListener('abort', rejectInterrupted)
  }
}

async function closeTrackedClient(client) {
  let closing = closePromises.get(client)
  if (closing === undefined) {
    closing = (async () => {
      try {
        await client.close()
      } catch (error) {
        shutdownCleanupFailures.push(error)
        throw error
      } finally {
        activeClients.delete(client)
      }
    })()
    closePromises.set(client, closing)
  }
  await closing
}

async function closeActiveClients() {
  return Promise.allSettled([...activeClients].map(closeTrackedClient))
}

function requestInterruption(name, exitCode) {
  if (requestedSignal !== undefined) process.exit(exitCode)
  requestedSignal = { name, exitCode }
  runnerAbort.abort(interruptionError())
  void closeActiveClients()
}

const onSigint = () => requestInterruption('SIGINT', 130)
const onSigterm = () => requestInterruption('SIGTERM', 143)
process.on('SIGINT', onSigint)
process.on('SIGTERM', onSigterm)

const cases = [
  {
    id: 'foreground-success',
    expected: { uniqueChildren: 1, activationsPerChild: 1, settlements: 0, reports: 0, sendCalls: 0, maxRequests: 6, maxNotifications: MAX_NOTIFICATIONS_PER_CASE, maxTokens: MAX_OUTPUT_TOKENS },
    prompt: 'This is a deterministic DeepSeek Harness contract probe. Call the subagent tool exactly once. Use description "contract:foreground-success", set run_in_background to false, and instruct the child to reply with only CONTRACT-FOREGROUND-OK. After the tool returns, reply with only that same token.',
  },
  {
    id: 'two-admissions',
    expected: { uniqueChildren: 2, activationsPerChild: 1, settlements: 0, reports: 0, sendCalls: 0, maxRequests: 8, maxNotifications: MAX_NOTIFICATIONS_PER_CASE, maxTokens: MAX_OUTPUT_TOKENS },
    prompt: 'This is a deterministic DeepSeek Harness contract probe. In one model step, call the subagent tool twice. Use descriptions "contract:admission-a" and "contract:admission-b", set run_in_background to false for both, and ask each child to return only its description. Then reply OK.',
  },
  {
    id: 'continuable-fifo',
    disableReport: true,
    enableControl: true,
    expected: { uniqueChildren: 1, activationsPerChild: 3, settlements: 3, reports: 0, sendCalls: 2, maxRequests: 16, maxNotifications: MAX_NOTIFICATIONS_PER_CASE, maxTokens: MAX_OUTPUT_TOKENS },
    prompt: 'This is a deterministic lifecycle probe. Call subagent exactly once with description "contract:continuable-fifo", run_in_background true, and a prompt that asks the child to reply READY. Do not omit run_in_background. After the start result, do not use job tools, list_agents, shell tools, or start another child. Let the turn end while the child runs. Only after the first subagent-settled notice, call send_message once with message FIRST and the returned child id, then let the turn end and wait. Only after the second settlement, send SECOND to that same id, then let the turn end and wait again. After the third settlement, reply with only the child id. Never finish before the third settlement.',
  },
  {
    id: 'continuable-report',
    expected: { uniqueChildren: 1, activationsPerChild: 1, settlements: 1, reports: 1, sendCalls: 0, maxRequests: 8, maxNotifications: MAX_NOTIFICATIONS_PER_CASE, maxTokens: MAX_OUTPUT_TOKENS },
    prompt: 'This is a deterministic report-order probe. Call subagent exactly once with description "contract:continuable-report", run_in_background true, and a prompt that tells the child to call report exactly once with output CONTRACT-REPORT-OK and then reply DONE. Do not omit run_in_background. After the start result, do not call send_message, job tools, list_agents, or shell tools, and do not query the child. Let the turn end while the child runs. Wait for the runtime to deliver both the explicit subagent-report relay and the subagent-settled notice. Only after both have arrived, reply with only OK.',
  },
]

function stablePathCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

async function fileSha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function sessionLogs(root) {
  const found = []
  async function visit(path) {
    try {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name)
        if (entry.isDirectory()) await visit(full)
        else if (entry.isFile() && entry.name === 'session.jsonl') {
          found.push(full)
          if (found.length > MAX_TRACE_PATHS) {
            throw runnerFailure(RUNNER_FAILURE.TRACE_SAFETY, { publicSummary: `trace count exceeded ${MAX_TRACE_PATHS} files` })
          }
        }
      }
    } catch (error) {
      if (error?.reason !== undefined) throw error
      throw runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, { cause: error })
    }
  }
  await visit(root)
  const metadataRows = []
  let totalBytes = 0
  for (const path of found) {
    let metadata
    try {
      metadata = await stat(path)
    } catch (error) {
      throw runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, { cause: error })
    }
    if (metadata.size > MAX_TRACE_BYTES) throw runnerFailure(RUNNER_FAILURE.TRACE_SAFETY, { publicSummary: 'one session log exceeded 64 MiB' })
    totalBytes += metadata.size
    if (totalBytes > MAX_CASE_TRACE_BYTES) throw runnerFailure(RUNNER_FAILURE.TRACE_SAFETY, { publicSummary: 'case trace set exceeded 128 MiB' })
    metadataRows.push({ path, size: metadata.size })
  }
  const rows = []
  for (const row of metadataRows) {
    const { path, size } = row
    let session
    try {
      session = await loadSessionLog(path)
    } catch (error) {
      throw runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, { cause: error })
    }
    if (!Number.isFinite(session.header?.createdAt)) throw runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, { publicSummary: 'one session log omitted a finite creation time' })
    rows.push({ path, size, session })
  }
  rows.sort((left, right) => left.session.header.createdAt - right.session.header.createdAt || stablePathCompare(left.path, right.path))
  return rows
}

function assertPermissionState(rootSession) {
  const latest = type => rootSession.ownEvents.filter(event => event.type === type).at(-1)?.data
  if (latest('permission/preset')?.preset !== 'contract-eval') throw runnerFailure(RUNNER_FAILURE.PERMISSION_INVARIANT, { publicSummary: 'root session did not persist preset contract-eval' })
  if (latest('sandbox/mode')?.mode !== 'workspace-write') throw runnerFailure(RUNNER_FAILURE.PERMISSION_INVARIANT, { publicSummary: 'root session did not persist workspace-write sandbox mode' })
  if (latest('approval/policy')?.policy !== 'never') throw runnerFailure(RUNNER_FAILURE.PERMISSION_INVARIANT, { publicSummary: 'root session did not persist approval policy never' })
}

function assertRequestCaps(rows, maxTokens) {
  let requests = 0
  for (const row of rows) {
    for (const event of row.session.ownEvents) {
      if (event?.type !== 'request/header') continue
      requests += 1
      const actual = event?.data?.header?.config?.maxTokens
      if (!Number.isSafeInteger(actual) || actual < 1 || actual > maxTokens) {
        throw runnerFailure(RUNNER_FAILURE.MAX_TOKEN_BREACH, { publicSummary: `request maxTokens exceeded or omitted ${maxTokens}` })
      }
    }
  }
  if (requests === 0) throw runnerFailure(RUNNER_FAILURE.MAX_TOKEN_BREACH, { publicSummary: 'session logs contained no request/header to inspect' })
}

function childEnvironment() {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('DEEPSEEK_API_KEY must be present in the launching process environment')
  }
  return publicDeepSeekEnvironment(scrubbedParentEnv(), apiKey)
}

async function runCase(caseValue, runRoot, model, env, attempt) {
  const caseRoot = join(runRoot, caseValue.id, `attempt-${attempt}`)
  const dshHome = join(caseRoot, 'dsh-home')
  const workspace = join(caseRoot, 'workspace')
  await mkdir(dshHome, { recursive: true })
  await mkdir(workspace, { recursive: true })
  const sessionId = `contract-${caseValue.id}-${randomUUID()}`
  const state = freshState()
  const deadline = Date.now() + CASE_TIMEOUT_MS
  const patches = [join(experimentRoot, 'trial-overlay.cordis.yml')]
  if (caseValue.disableReport === true) patches.push(join(experimentRoot, 'no-report.cordis.yml'))
  if (caseValue.enableControl !== true) patches.push(join(experimentRoot, 'no-control.cordis.yml'))
  const client = new HarnessClient({
    profile: 'sdk',
    patches,
    dshHome,
    processCwd: workspace,
    env,
    initializeTimeoutMs: 30_000,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    shutdownTimeoutMs: 5_000,
  })
  const subscription = client.subscribeSessionTree(sessionId)
  activeClients.add(client)
  let primaryFailure
  let cleanupFailure
  let serverInfo
  let timer
  try {
    client.start()
    const initialized = await withInterruption(() => client.initialize({ cwd: workspace, provider: 'deepseek-official', model, maxTokens: MAX_OUTPUT_TOKENS }))
    serverInfo = initialized.serverInfo
    await withInterruption(() => client.prompt(sessionId, [{ type: 'text', text: caseValue.prompt }]))
    while (!lifecycleComplete(state, caseValue.expected)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw runnerFailure(RUNNER_FAILURE.TIMEOUT)
      const notification = await withInterruption(() => {
        const next = subscription.next()
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(runnerFailure(RUNNER_FAILURE.TIMEOUT)), remaining)
        })
        return Promise.race([next, timeout])
      })
      clearTimeout(timer)
      try {
        observe(state, sessionId, notification, caseValue.expected)
      } catch (error) {
        throw runnerFailure(
          error instanceof Error && error.message.includes('token safety limit')
            ? RUNNER_FAILURE.MAX_TOKEN_BREACH
            : RUNNER_FAILURE.LIFECYCLE_INVARIANT,
          { cause: error },
        )
      }
    }
  } catch (error) {
    primaryFailure = error
  } finally {
    clearTimeout(timer)
    subscription.close()
    try {
      await closeTrackedClient(client)
    } catch (error) {
      cleanupFailure = runnerFailure(RUNNER_FAILURE.CLEANUP_FAILURE, { cause: error })
    }
  }

  let rows = []
  let offlineVerification
  if (cleanupFailure === undefined) {
    try {
      rows = await sessionLogs(join(dshHome, 'sessions'))
      const roots = rows.filter(row => row.session.header.origin !== 'subagent')
      if (roots.length !== 1) throw runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, { publicSummary: `root session cardinality was ${roots.length}; expected 1` })
      assertPermissionState(roots[0].session)
      assertRequestCaps(rows, caseValue.expected.maxTokens)
      offlineVerification = verifyTrial({ caseId: caseValue.id, trial: 1, status: 'completed', sessions: rows.map(row => row.session) })
    } catch (error) {
      primaryFailure ??= error
    }
  }
  const offlineFailure = offlineVerification === undefined ? undefined : failureFromOfflineVerification(offlineVerification)
  primaryFailure ??= offlineFailure
  const tracePaths = rows.map(row => row.path)
  const rootRow = rows.find(row => row.session.header.origin !== 'subagent')
  const decisiveFailure = cleanupFailure ?? primaryFailure
  const decision = decisiveFailure === undefined ? undefined : classifyRunnerFailure(decisiveFailure, { caseId: caseValue.id })
  const primaryDecision = primaryFailure === undefined ? undefined : classifyRunnerFailure(primaryFailure, { caseId: caseValue.id })
  const retryable = requestedSignal === undefined && cleanupFailure === undefined && decision?.retryEligible === true
  const failed = decisiveFailure === undefined ? undefined : publicFailure(decisiveFailure, { caseId: caseValue.id })
  return {
    retryable,
    result: {
      caseId: caseValue.id,
      attempt,
      trial: 1,
      status: failed === undefined ? 'completed' : 'error',
      ...(rootRow === undefined ? {} : { tracePath: rootRow.path }),
      tracePaths,
      exitCode: failed === undefined ? 0 : 1,
      timedOut: failed?.timedOut ?? false,
      ...(failed === undefined ? {} : { error: failed.error }),
    },
    summary: {
      caseId: caseValue.id,
      attempt,
      status: failed === undefined ? 'completed' : 'error',
      traceCount: tracePaths.length,
      uniqueChildren: state.children.size,
      started: state.started,
      finished: state.finished,
      openActivations: state.openActivations,
      settlements: state.settlements,
      reports: state.reports,
      sendCalls: state.sendCalls,
      notificationCounts: Object.fromEntries([...state.methods].sort()),
      modelRequests: state.modelRequests,
      serverInfo,
      cleanupStatus: cleanupFailure === undefined ? 'closed' : 'unproven',
      ...(decision === undefined ? {} : { failureClass: decision.reason, retryable }),
      ...(cleanupFailure !== undefined && primaryDecision !== undefined ? { primaryFailureClass: primaryDecision.reason } : {}),
      offlineVerifier: offlineVerification === undefined
        ? undefined
        : {
            scenarioStatus: offlineVerification.coverage.scenarioStatus,
            violations: offlineVerification.violations.length,
            compatibilityErrors: offlineVerification.compatibility.length,
          },
    },
  }
}

async function main() {
  const env = childEnvironment()
  const model = process.env.DSH_CONTRACT_MODEL ?? 'deepseek-v4-pro'
  const runId = randomUUID()
  const runRoot = join(experimentRoot, 'runs', `alpha2-sdk-${Date.now()}-${runId}`)
  await mkdir(runRoot, { recursive: true })
  const results = []
  const attempts = {}
  caseLoop: for (const caseValue of cases) {
    throwIfInterrupted()
    const caseAttempts = []
    let selected
    for (let attempt = 1; attempt <= MAX_CASE_ATTEMPTS; attempt += 1) {
      const candidate = await runCase(caseValue, runRoot, model, env, attempt)
      caseAttempts.push(candidate.summary)
      selected = candidate
      if (candidate.result.status === 'completed' || !candidate.retryable || requestedSignal !== undefined) break
    }
    attempts[caseValue.id] = caseAttempts
    results.push(selected)
    if (requestedSignal !== undefined) return
    if (selected.result.status !== 'completed') break caseLoop
  }

  throwIfInterrupted()
  const artifact = {
    producer: 'dsh-subagent-contract-sdk-runner',
    producerVersion: '0.1.0-preview.1-experimental',
    runId,
    benchmark: 'dsh-subagent-contract-v0.1',
    model,
    createdAt: Date.now(),
    trials: 1,
    seed: 0,
    pricing: null,
    tempRoot: runRoot,
    attempts,
    environment: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      sdkClient: '0.1.2-alpha.2',
      deepseekEndpointMode: 'public',
      deepseekEndpointOrigin: PUBLIC_DEEPSEEK_BASE_URL,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      runnerSha256: await fileSha256(fileURLToPath(import.meta.url)),
      lifecycleSha256: await fileSha256(join(experimentRoot, 'lifecycle.mjs')),
      runnerEnvironmentSha256: await fileSha256(join(experimentRoot, 'runner-environment.mjs')),
      runnerPolicySha256: await fileSha256(join(experimentRoot, 'runner-policy.mjs')),
      experimentLockSha256: await fileSha256(join(experimentRoot, 'package-lock.json')),
      overlaySha256: await fileSha256(join(experimentRoot, 'trial-overlay.cordis.yml')),
      noReportOverlaySha256: await fileSha256(join(experimentRoot, 'no-report.cordis.yml')),
      noControlOverlaySha256: await fileSha256(join(experimentRoot, 'no-control.cordis.yml')),
    },
    cases: results.map(item => item.result),
  }
  const output = resolve(process.argv[2] ?? join(runRoot, 'alpha2-sdk.run.json'))
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  console.log(JSON.stringify({ output, runId, cases: results.map(item => item.summary) }, null, 2))
  if (results.some(item => item.result.status !== 'completed')) process.exitCode = 1
}

try {
  await main()
} catch (error) {
  if (requestedSignal === undefined) {
    console.error(publicFailure(error, { caseId: 'runner' }).error)
    process.exitCode = 1
  }
} finally {
  const cleanup = await closeActiveClients()
  process.off('SIGINT', onSigint)
  process.off('SIGTERM', onSigterm)
  if (cleanup.some(item => item.status === 'rejected') && requestedSignal === undefined) process.exitCode = 1
}

if (requestedSignal !== undefined) {
  console.error(shutdownCleanupFailures.length === 0
    ? `runner interrupted by ${requestedSignal.name}; active SDK clients were closed before exit`
    : `runner interrupted by ${requestedSignal.name}; SDK shutdown was attempted but clean exit is unproven`)
  process.exitCode = requestedSignal.exitCode
}
