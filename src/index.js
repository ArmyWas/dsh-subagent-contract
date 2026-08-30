import { basename, resolve } from 'node:path'
import { verifyTrial } from './contracts.js'
import { BUNDLED_BENCHMARK, BUNDLED_CASE_IDS, diagnostic } from './diagnostics.js'
import { loadRunArtifact, loadTrialTraceSets } from './run-artifact.js'

const MAX_BUNDLED_TRIALS = 16

export { verifyTrial } from './contracts.js'
export { loadRunArtifact, loadTrialTraceSets } from './run-artifact.js'
export { loadSessionLog, parseSessionLog } from './session-log.js'

function matrixCompatibility(run) {
  const compatibility = []
  if (run.benchmark !== BUNDLED_BENCHMARK) {
    compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_BENCHMARK_UNSUPPORTED', `expected bundled benchmark ${BUNDLED_BENCHMARK}, received ${run.benchmark}`))
  }
  if (!Number.isSafeInteger(run.trials) || run.trials < 1) {
    compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_TRIAL_COUNT_INVALID', 'bundled benchmark artifact must declare a positive integer trials count'))
    return compatibility
  }
  if (run.trials > MAX_BUNDLED_TRIALS) {
    compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_TRIAL_COUNT_EXCESSIVE', `bundled benchmark artifact declares more than the ${MAX_BUNDLED_TRIALS}-trial safety limit`))
    return compatibility
  }
  const counts = new Map()
  for (const item of run.cases) {
    if (typeof item?.caseId !== 'string' || !Number.isSafeInteger(item?.trial) || item.trial < 1) {
      compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_MATRIX_ENTRY_INVALID', 'run contains a case without a valid caseId and positive trial number'))
      continue
    }
    if (!BUNDLED_CASE_IDS.includes(item.caseId) || item.trial > run.trials) {
      compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_MATRIX_ENTRY_UNKNOWN', `unexpected bundled matrix entry ${item.caseId}#${item.trial}`, { caseId: item.caseId, trial: item.trial }))
      continue
    }
    const key = `${item.caseId}#${item.trial}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const caseId of BUNDLED_CASE_IDS) {
    for (let trial = 1; trial <= run.trials; trial += 1) {
      const key = `${caseId}#${trial}`
      const count = counts.get(key) ?? 0
      if (count === 0) {
        compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_MATRIX_ENTRY_MISSING', `missing bundled matrix entry ${key}`, { caseId, trial }))
      } else if (count > 1) {
        compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_MATRIX_ENTRY_DUPLICATE', `bundled matrix entry ${key} appears ${count} times`, { caseId, trial }))
      }
    }
  }
  return compatibility
}

function diagnosticTrialKey(item) {
  return typeof item?.caseId === 'string' && Number.isSafeInteger(item?.trial)
    ? `${item.caseId}#${item.trial}`
    : undefined
}

/** Verify a dsh-eval run artifact and return stable machine-readable output. */
export async function verifyRun(runPath) {
  const absolute = resolve(runPath)
  const run = await loadRunArtifact(absolute)
  const loaded = await loadTrialTraceSets(absolute, run)
  const violations = []
  const compatibility = [...matrixCompatibility(run), ...loaded.compatibility]
  const coverage = []
  let verifiedTrials = 0
  let skippedTrials = 0
  let passedTrials = 0
  let failedTrials = 0
  const inconclusiveKeys = new Set(compatibility.map(diagnosticTrialKey).filter(Boolean))
  for (const trial of loaded.trials) {
    if (trial.status !== 'completed') {
      skippedTrials += 1
      compatibility.push(diagnostic(
        'compatibility',
        'RUN_ARTIFACT',
        'RUN_TRIAL_INCOMPLETE',
        `bundled trial ${trial.caseId}#${trial.trial} did not complete; inspect the source artifact locally for its host diagnostic`,
        { caseId: trial.caseId, trial: trial.trial },
      ))
      inconclusiveKeys.add(`${trial.caseId}#${trial.trial}`)
      continue
    }
    verifiedTrials += 1
    const result = verifyTrial(trial)
    violations.push(...result.violations)
    compatibility.push(...result.compatibility)
    coverage.push(result.coverage)
    if (result.compatibility.length > 0) inconclusiveKeys.add(`${trial.caseId}#${trial.trial}`)
    else if (result.violations.length > 0) failedTrials += 1
    else passedTrials += 1
  }
  if (verifiedTrials === 0 && compatibility.length === 0) {
    compatibility.push({
      severity: 'compatibility',
      contract: 'RUN_ARTIFACT',
      code: 'RUN_NO_VERIFIABLE_TRIALS',
      message: 'run artifact contains no completed trial with readable trace paths',
    })
  }
  const exitCode = compatibility.length > 0 ? 2 : violations.length > 0 ? 1 : 0
  const sourceKind = run.producer === 'dsh-subagent-contract-sdk-runner' ? 'sdk-runner-claim' : 'dsh-eval-compatible'
  return {
    schemaVersion: 1,
    tool: 'dsh-subagent-contract',
    contract: 'dsh-subagent/v0.1',
    source: {
      kind: sourceKind,
      benchmark: run.benchmark,
      artifact: basename(absolute),
    },
    summary: {
      trials: run.cases.length,
      verified: verifiedTrials,
      skipped: skippedTrials,
      passed: passedTrials,
      failed: failedTrials,
      inconclusive: inconclusiveKeys.size,
      violations: violations.length,
      compatibilityErrors: compatibility.length,
    },
    coverage,
    violations,
    compatibility,
    exitCode,
  }
}
