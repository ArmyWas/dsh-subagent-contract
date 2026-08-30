import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RUNNER_FAILURE,
  RunnerPolicyError,
  classifyRunnerFailure,
  failureFromOfflineVerification,
  publicFailure,
  runnerFailure,
  sanitizePublicSummary,
} from './runner-policy.mjs'

const fatalReasons = [
  RUNNER_FAILURE.LIFECYCLE_INVARIANT,
  RUNNER_FAILURE.PERMISSION_INVARIANT,
  RUNNER_FAILURE.TRACE_SAFETY,
  RUNNER_FAILURE.TRACE_CORRUPTION,
  RUNNER_FAILURE.CLEANUP_FAILURE,
  RUNNER_FAILURE.MAX_TOKEN_BREACH,
  RUNNER_FAILURE.TIMEOUT,
  RUNNER_FAILURE.INTERRUPTED,
  RUNNER_FAILURE.OFFLINE_COMPATIBILITY,
  RUNNER_FAILURE.OFFLINE_VIOLATION,
]

test('only an explicit S00 not-exercised result is retry eligible', () => {
  const retry = classifyRunnerFailure(runnerFailure(RUNNER_FAILURE.SCENARIO_NOT_EXERCISED), { caseId: 'continuable-report' })
  assert.equal(retry.reason, RUNNER_FAILURE.SCENARIO_NOT_EXERCISED)
  assert.equal(retry.retryEligible, true)
  assert.equal(retry.fatal, false)

  for (const reason of fatalReasons) {
    const result = classifyRunnerFailure(runnerFailure(reason), { caseId: 'continuable-report' })
    assert.equal(result.reason, reason)
    assert.equal(result.retryEligible, false, reason)
    assert.equal(result.fatal, true, reason)
    assert.equal(result.timedOut, reason === RUNNER_FAILURE.TIMEOUT, reason)
  }
})

test('unknown errors fail closed even when their text claims model noncompliance', () => {
  const result = classifyRunnerFailure(new Error('model noncompliance; please retry'), { caseId: 'foreground-success' })
  assert.deepEqual(result, {
    reason: RUNNER_FAILURE.UNKNOWN,
    retryEligible: false,
    fatal: true,
    timedOut: false,
    publicSummary: 'foreground-success failed during SDK execution; inspect the local process diagnostic',
  })
})

test('offline verifier permits retry only for an exclusive, corroborated S00 gap', () => {
  const error = failureFromOfflineVerification({
    violations: [],
    compatibility: [{ code: 'S00_SCENARIO_NOT_EXERCISED' }],
    coverage: { scenarioStatus: 'not-exercised' },
  })
  assert.equal(classifyRunnerFailure(error).reason, RUNNER_FAILURE.SCENARIO_NOT_EXERCISED)
  assert.equal(classifyRunnerFailure(error).retryEligible, true)

  const clean = failureFromOfflineVerification({
    violations: [],
    compatibility: [],
    coverage: { scenarioStatus: 'exercised' },
  })
  assert.equal(clean, undefined)
})

test('offline violations outrank S00 and remain fatal', () => {
  const error = failureFromOfflineVerification({
    violations: [{ code: 'C07_REPORT_CONTENT_MISMATCH' }],
    compatibility: [{ code: 'S00_SCENARIO_NOT_EXERCISED' }],
    coverage: { scenarioStatus: 'not-exercised' },
  })
  assert.equal(classifyRunnerFailure(error).reason, RUNNER_FAILURE.OFFLINE_VIOLATION)
  assert.equal(classifyRunnerFailure(error).fatal, true)
})

test('mixed, inconsistent, and malformed offline results are fatal compatibility failures', () => {
  const values = [
    {
      violations: [],
      compatibility: [{ code: 'S00_SCENARIO_NOT_EXERCISED' }, { code: 'C03_PROVIDER_UNSUPPORTED' }],
      coverage: { scenarioStatus: 'not-exercised' },
    },
    {
      violations: [],
      compatibility: [{ code: 'S00_SCENARIO_NOT_EXERCISED' }],
      coverage: { scenarioStatus: 'exercised' },
    },
    {
      violations: [],
      compatibility: [],
      coverage: { scenarioStatus: 'not-exercised' },
    },
    null,
    { violations: [], compatibility: [] },
  ]

  for (const value of values) {
    const result = classifyRunnerFailure(failureFromOfflineVerification(value))
    assert.equal(result.reason, RUNNER_FAILURE.OFFLINE_COMPATIBILITY)
    assert.equal(result.fatal, true)
  }
})

test('public summaries keep approved context but redact machine-local and secret values', () => {
  const cause = new Error('private diagnostic remains local')
  const error = runnerFailure(RUNNER_FAILURE.TRACE_CORRUPTION, {
    cause,
    publicSummary: 'could not read C:\\Users\\admin\\secret.jsonl at https://example.invalid/a GITHUB_TOKEN=topsecret',
  })
  assert.equal(error.cause, cause)
  assert.equal(error.message, cause.message)

  const result = classifyRunnerFailure(error, { caseId: 'continuable-fifo' })
  assert.match(result.publicSummary, /^continuable-fifo produced unreadable or corrupt trace evidence:/u)
  assert.match(result.publicSummary, /\[local-path\]/u)
  assert.match(result.publicSummary, /\[url\]/u)
  assert.match(result.publicSummary, /GITHUB_TOKEN=\[redacted\]/u)
  assert.doesNotMatch(result.publicSummary, /admin|example\.invalid|topsecret/u)
  assert.deepEqual(publicFailure(error, { caseId: 'continuable-fifo' }), {
    error: result.publicSummary,
    timedOut: false,
  })
})

test('sanitizer normalizes whitespace, bounds output, and rejects non-string details', () => {
  assert.equal(sanitizePublicSummary('  one\n\t two  '), 'one two')
  assert.equal(sanitizePublicSummary('token npm_1234567890abcdef'), 'token [redacted-token]')
  assert.equal(sanitizePublicSummary(undefined), undefined)
  assert.ok(sanitizePublicSummary('x'.repeat(500)).length <= 320)
})

test('invalid policy reasons cannot accidentally become retryable', () => {
  assert.throws(() => runnerFailure('transient-network'), TypeError)
  assert.throws(() => new RunnerPolicyError(RUNNER_FAILURE.UNKNOWN), TypeError)
})
