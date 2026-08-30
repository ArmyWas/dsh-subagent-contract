const RETRYABLE_REASONS = new Set([
  's00-scenario-not-exercised',
])

const KNOWN_REASONS = new Set([
  ...RETRYABLE_REASONS,
  'lifecycle-invariant',
  'permission-invariant',
  'trace-safety',
  'trace-corruption',
  'cleanup-failure',
  'max-token-breach',
  'timeout',
  'interrupted',
  'offline-compatibility',
  'offline-violation',
  'unknown',
])

export const RUNNER_FAILURE = Object.freeze({
  SCENARIO_NOT_EXERCISED: 's00-scenario-not-exercised',
  LIFECYCLE_INVARIANT: 'lifecycle-invariant',
  PERMISSION_INVARIANT: 'permission-invariant',
  TRACE_SAFETY: 'trace-safety',
  TRACE_CORRUPTION: 'trace-corruption',
  CLEANUP_FAILURE: 'cleanup-failure',
  MAX_TOKEN_BREACH: 'max-token-breach',
  TIMEOUT: 'timeout',
  INTERRUPTED: 'interrupted',
  OFFLINE_COMPATIBILITY: 'offline-compatibility',
  OFFLINE_VIOLATION: 'offline-violation',
  UNKNOWN: 'unknown',
})

const SUMMARY_BY_REASON = Object.freeze({
  [RUNNER_FAILURE.SCENARIO_NOT_EXERCISED]: 'did not exercise the required fixed scenario',
  [RUNNER_FAILURE.LIFECYCLE_INVARIANT]: 'violated an internal lifecycle invariant',
  [RUNNER_FAILURE.PERMISSION_INVARIANT]: 'did not persist the required permission state',
  [RUNNER_FAILURE.TRACE_SAFETY]: 'exceeded a trace safety boundary',
  [RUNNER_FAILURE.TRACE_CORRUPTION]: 'produced unreadable or corrupt trace evidence',
  [RUNNER_FAILURE.CLEANUP_FAILURE]: 'failed while closing the SDK client',
  [RUNNER_FAILURE.MAX_TOKEN_BREACH]: 'exceeded the fixed token safety limit',
  [RUNNER_FAILURE.TIMEOUT]: 'timed out before its durable completion boundary',
  [RUNNER_FAILURE.INTERRUPTED]: 'was interrupted before the evidence boundary and shut down',
  [RUNNER_FAILURE.OFFLINE_COMPATIBILITY]: 'produced evidence that the offline verifier cannot safely interpret',
  [RUNNER_FAILURE.OFFLINE_VIOLATION]: 'violated the verified subagent contract',
  [RUNNER_FAILURE.UNKNOWN]: 'failed during SDK execution; inspect the local process diagnostic',
})

const MAX_PUBLIC_SUMMARY_LENGTH = 320

function safeCaseId(caseId) {
  return typeof caseId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(caseId)
    ? caseId
    : 'case'
}

/**
 * Redact common secret and local-machine shapes before text is persisted in a
 * public run artifact. The original Error remains available locally as
 * `cause`; this function is deliberately lossy.
 */
export function sanitizePublicSummary(value) {
  if (typeof value !== 'string') return undefined
  let summary = value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
  if (summary === '') return undefined

  summary = summary
    .replace(/\b(DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|NPM_TOKEN|GITHUB_TOKEN)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/\b(?:npm|gh[opusr]|github_pat|sk)[_-][a-z0-9_-]{12,}\b/giu, '[redacted-token]')
    .replace(/\\\\[^\s"'<>]+/gu, '[network-path]')
    .replace(/\b[a-z]:[\\/][^\s"'<>]+/giu, '[local-path]')
    .replace(/\b(?:https?|file):\/\/[^\s"'<>]+/giu, '[url]')

  if (summary.length > MAX_PUBLIC_SUMMARY_LENGTH) {
    summary = `${summary.slice(0, MAX_PUBLIC_SUMMARY_LENGTH - 1)}…`
  }
  return summary
}

export class RunnerPolicyError extends Error {
  constructor(reason, options = {}) {
    if (!KNOWN_REASONS.has(reason) || reason === RUNNER_FAILURE.UNKNOWN) {
      throw new TypeError(`RunnerPolicyError requires a specific known failure reason; received ${String(reason)}`)
    }
    const causeMessage = options.cause instanceof Error ? options.cause.message : undefined
    super(causeMessage ?? SUMMARY_BY_REASON[reason], options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RunnerPolicyError'
    this.reason = reason
    this.publicSummary = sanitizePublicSummary(options.publicSummary)
  }
}

export function runnerFailure(reason, options) {
  return new RunnerPolicyError(reason, options)
}

/**
 * Classify a runner failure without guessing from arbitrary Error text.
 * Unknown/untyped failures fail closed and are never retryable.
 */
export function classifyRunnerFailure(error, options = {}) {
  const caseId = safeCaseId(options.caseId)
  const typed = error instanceof RunnerPolicyError
  const reason = typed ? error.reason : RUNNER_FAILURE.UNKNOWN
  const retryEligible = RETRYABLE_REASONS.has(reason)
  const detail = typed ? error.publicSummary : undefined
  const canonical = `${caseId} ${SUMMARY_BY_REASON[reason]}`
  const publicSummary = detail === undefined ? canonical : `${canonical}: ${detail}`

  return Object.freeze({
    reason,
    retryEligible,
    fatal: !retryEligible,
    timedOut: reason === RUNNER_FAILURE.TIMEOUT,
    publicSummary,
  })
}

/**
 * Turn a full verifyTrial result into a typed failure. A retry is permitted
 * only when the verifier reports exclusively S00_SCENARIO_NOT_EXERCISED and
 * coverage agrees that the scenario was not exercised. Any violation,
 * additional compatibility diagnostic, or malformed result is fatal.
 */
export function failureFromOfflineVerification(verification) {
  if (verification === null || typeof verification !== 'object'
    || !Array.isArray(verification.violations)
    || !Array.isArray(verification.compatibility)
    || verification.coverage === null
    || typeof verification.coverage !== 'object') {
    return runnerFailure(RUNNER_FAILURE.OFFLINE_COMPATIBILITY)
  }

  if (verification.violations.length > 0) {
    return runnerFailure(RUNNER_FAILURE.OFFLINE_VIOLATION)
  }

  const scenarioStatus = verification.coverage.scenarioStatus
  const compatibilityCodes = verification.compatibility.map(item => item?.code)
  const exclusivelyS00 = compatibilityCodes.length > 0
    && compatibilityCodes.every(code => code === 'S00_SCENARIO_NOT_EXERCISED')

  if (scenarioStatus === 'not-exercised' && exclusivelyS00) {
    return runnerFailure(RUNNER_FAILURE.SCENARIO_NOT_EXERCISED)
  }

  if (scenarioStatus !== 'exercised' || verification.compatibility.length > 0) {
    return runnerFailure(RUNNER_FAILURE.OFFLINE_COMPATIBILITY)
  }

  return undefined
}

/** Artifact-compatible public fields; raw causes and local diagnostics stay out. */
export function publicFailure(error, options = {}) {
  const classification = classifyRunnerFailure(error, options)
  return Object.freeze({ error: classification.publicSummary, timedOut: classification.timedOut })
}
