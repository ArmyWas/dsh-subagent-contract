/** Stable contract identifiers exposed in machine-readable output. */
export const CONTRACT_IDS = Object.freeze({
  scenario: 'S00_SCENARIO_COVERAGE',
  lineage: 'C01_LINEAGE_GRAPH',
  descriptor: 'C02_OWN_DESCRIPTOR',
  admission: 'C03_ADMISSION_CARDINALITY',
  foreground: 'C04_FOREGROUND_OUTCOME',
  continuation: 'C05_CONTINUATION_IDENTITY_FIFO',
  settlement: 'C06_SETTLEMENT_PROVENANCE',
  report: 'C07_REPORT_PROVENANCE',
})

export const BUNDLED_BENCHMARK = 'dsh-subagent-contract-v0.1'

export const BUNDLED_CASE_IDS = Object.freeze([
  'foreground-success',
  'two-admissions',
  'continuable-fifo',
  'continuable-report',
])

/**
 * Create a stable diagnostic object.
 * @param {'violation'|'compatibility'} severity
 * @param {string} contract
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 */
export function diagnostic(severity, contract, code, message, context = {}) {
  return { severity, contract, code, message, ...context }
}
