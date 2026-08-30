import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { arch, release, type } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSessionLog, verifyRun } from '../src/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha256(path) {
  return sha256(await readFile(path))
}

function compactCoverage(item) {
  const result = {
    caseId: item.caseId,
    scenarioStatus: item.scenarioStatus,
    sessions: item.sessions,
    subagentCalls: item.subagentCalls,
  }
  for (const key of ['foregroundCalls', 'backgroundCalls', 'sendMessageCalls', 'reportCalls', 'reportRelays', 'settlementNotices']) {
    if (item[key] > 0) result[key] = item[key]
  }
  return result
}

const [runArgument, executedRunnerArgument] = process.argv.slice(2)
if (!runArgument || !executedRunnerArgument) {
  console.error('usage: node scripts/generate-evidence.mjs <run.json> <executed-runner.mjs>')
  process.exitCode = 2
} else {
  const runPath = resolve(runArgument)
  const executedRunnerPath = resolve(executedRunnerArgument)
  const publishedRunnerPath = join(root, 'experiments', 'sdk-runner', 'run-matrix.mjs')
  const lifecyclePath = join(root, 'experiments', 'sdk-runner', 'lifecycle.mjs')
  const runnerEnvironmentPath = join(root, 'experiments', 'sdk-runner', 'runner-environment.mjs')
  const runnerPolicyPath = join(root, 'experiments', 'sdk-runner', 'runner-policy.mjs')
  const publishedLockPath = join(root, 'experiments', 'sdk-runner', 'package-lock.json')
  const overlayPath = join(root, 'experiments', 'sdk-runner', 'trial-overlay.cordis.yml')
  const noReportOverlayPath = join(root, 'experiments', 'sdk-runner', 'no-report.cordis.yml')
  const noControlOverlayPath = join(root, 'experiments', 'sdk-runner', 'no-control.cordis.yml')
  const experimentPackage = JSON.parse(await readFile(join(root, 'experiments', 'sdk-runner', 'package.json'), 'utf8'))
  const artifact = JSON.parse(await readFile(runPath, 'utf8'))
  const report = await verifyRun(runPath)
  const tracePaths = artifact.cases.flatMap(item => Array.isArray(item.tracePaths) ? item.tracePaths : [])
  const sessions = await Promise.all(tracePaths.map(loadSessionLog))
  const traceHashes = await Promise.all(tracePaths.map(fileSha256))
  traceHashes.sort()
  const createdTimes = sessions.map(session => session.header?.createdAt).filter(Number.isFinite)
  const earliestSessionCreatedAt = Math.min(...createdTimes)
  const artifactCreatedAt = Number.isFinite(artifact.createdAt) ? artifact.createdAt : null
  const duration = artifactCreatedAt !== null && Number.isFinite(earliestSessionCreatedAt)
    ? (artifactCreatedAt - earliestSessionCreatedAt) / 1_000
    : null
  const sdkVersion = experimentPackage.dependencies['@deepseek-ai/dsh-sdk-client']
  const executedRunnerSha256 = await fileSha256(executedRunnerPath)
  const publishedRunnerSha256 = await fileSha256(publishedRunnerPath)
  const lifecycleSha256 = await fileSha256(lifecyclePath)
  const runnerEnvironmentSha256 = await fileSha256(runnerEnvironmentPath)
  const runnerPolicySha256 = await fileSha256(runnerPolicyPath)
  const experimentLockSha256 = await fileSha256(publishedLockPath)
  const overlaySha256 = await fileSha256(overlayPath)
  const noReportOverlaySha256 = await fileSha256(noReportOverlayPath)
  const noControlOverlaySha256 = await fileSha256(noControlOverlayPath)
  const embedded = artifact.environment ?? {}
  if (executedRunnerSha256 !== publishedRunnerSha256) {
    throw new Error('supplied executed runner does not match the published experiment runner')
  }
  for (const [label, actual] of [
    ['runnerSha256', executedRunnerSha256],
    ['lifecycleSha256', lifecycleSha256],
    ['runnerEnvironmentSha256', runnerEnvironmentSha256],
    ['runnerPolicySha256', runnerPolicySha256],
    ['experimentLockSha256', experimentLockSha256],
    ['overlaySha256', overlaySha256],
    ['noReportOverlaySha256', noReportOverlaySha256],
    ['noControlOverlaySha256', noControlOverlaySha256],
  ]) {
    if (embedded[label] !== actual) {
      throw new Error(`artifact ${label} does not match the supplied source tree`)
    }
  }
  if (embedded.deepseekEndpointMode !== 'public'
    || embedded.deepseekEndpointOrigin !== 'https://api.deepseek.com'
    || embedded.maxOutputTokens !== 4_096) {
    throw new Error('artifact does not prove the fixed public endpoint and 4096-token safety policy')
  }
  const attemptCounts = Object.fromEntries(Object.entries(artifact.attempts ?? {}).map(([caseId, values]) => [caseId, Array.isArray(values) ? values.length : 0]))
  const serverInfo = Object.values(artifact.attempts ?? {}).flatMap(values => Array.isArray(values) ? values : [])
    .find(value => value?.status === 'completed')?.serverInfo
  const evidence = {
    capturedAt: artifactCreatedAt === null ? null : new Date(artifactCreatedAt).toISOString(),
    platform: `${process.platform}-${arch()}`,
    harness: `@deepseek-ai/dsh-sdk-client@${sdkVersion}`,
    model: artifact.model,
    runner: 'persistent SDK profile experiment',
    attestation: {
      status: 'self-attested local verification',
      artifactSha256: await fileSha256(runPath),
      executedRunnerSha256,
      publishedExperimentRunnerSha256: publishedRunnerSha256,
      lifecycleSha256,
      runnerEnvironmentSha256,
      runnerPolicySha256,
      publishedExperimentLockSha256: experimentLockSha256,
      overlaySha256,
      noReportOverlaySha256,
      noControlOverlaySha256,
      traceSetSha256: sha256(traceHashes.join('\n')),
      traceSetMethod: `SHA-256 of the newline-joined, lexicographically sorted SHA-256 content hashes of all ${tracePaths.length} session logs`,
      traceCount: tracePaths.length,
      artifactCreatedAt,
      earliestSessionCreatedAt: Number.isFinite(earliestSessionCreatedAt) ? earliestSessionCreatedAt : null,
      derivedDurationSeconds: duration,
      node: process.version,
      os: `${type()} ${release()}`,
    },
    runtime: {
      serverInfo,
      attempts: attemptCounts,
      endpointMode: embedded.deepseekEndpointMode,
      endpointOrigin: embedded.deepseekEndpointOrigin,
      maxOutputTokens: embedded.maxOutputTokens,
    },
    verdict: {
      trials: report.summary.trials,
      verified: report.summary.verified,
      passed: report.summary.passed,
      failed: report.summary.failed,
      inconclusive: report.summary.inconclusive,
      violations: report.summary.violations,
      compatibilityErrors: report.summary.compatibilityErrors,
      exitCode: report.exitCode,
    },
    coverage: report.coverage.map(compactCoverage),
    privacy: 'Structure-only summary. Raw prompts, responses, session ids, trace paths, and credentials are not included. Hashes refer to local evidence that is intentionally not committed.',
  }
  console.log(JSON.stringify(evidence, null, 2))
}
