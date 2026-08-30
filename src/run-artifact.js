import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { diagnostic } from './diagnostics.js'
import { loadSessionLog } from './session-log.js'

const MAX_TRACE_PATHS_PER_TRIAL = 16
const MAX_TRACE_BYTES = 64 * 1024 * 1024
const MAX_TRIAL_TRACE_BYTES = 128 * 1024 * 1024
const MAX_RUN_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_RUN_CASES = 64

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function remoteOrDevicePath(value) {
  return value.startsWith('\\\\') || value.startsWith('//')
}

/** Load the public run-artifact shape observed in dsh-eval 0.3.0 without importing its private modules. */
export async function loadRunArtifact(path) {
  if (remoteOrDevicePath(path)) {
    throw new Error('unsupported dsh-eval run artifact: remote or device-style paths are not read')
  }
  let run
  try {
    const metadata = await stat(path)
    if (metadata.size > MAX_RUN_ARTIFACT_BYTES) {
      throw new Error(`run artifact exceeds the ${MAX_RUN_ARTIFACT_BYTES}-byte safety limit`)
    }
    run = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read dsh-eval run artifact ${path}`, { cause: error })
  }
  if (!isRecord(run) || typeof run.benchmark !== 'string' || !Array.isArray(run.cases)) {
    throw new Error('unsupported dsh-eval run artifact: expected benchmark and cases[]')
  }
  if (run.cases.length > MAX_RUN_CASES) {
    throw new Error(`unsupported dsh-eval run artifact: cases[] exceeds the ${MAX_RUN_CASES}-entry safety limit`)
  }
  return run
}

/** Load every completed trial's raw tracePaths while preserving session boundaries. */
export async function loadTrialTraceSets(runPath, run) {
  const baseDir = dirname(resolve(runPath))
  const trials = []
  const compatibility = []
  for (const item of run.cases) {
    if (!isRecord(item)) {
      compatibility.push(diagnostic('compatibility', 'RUN_ARTIFACT', 'RUN_CASE_INVALID', 'run cases[] contains a non-object'))
      continue
    }
    const caseId = typeof item.caseId === 'string' ? item.caseId : '<unknown>'
    const trial = Number.isInteger(item.trial) ? item.trial : 0
    if (item.status !== 'completed') {
      trials.push({ caseId, trial, status: 'skipped', sessions: [], reason: item.error ?? 'trial did not complete' })
      continue
    }
    const rawPaths = Array.isArray(item.tracePaths) && item.tracePaths.length > 0
      ? item.tracePaths
      : []
    if (rawPaths.length === 0 || rawPaths.some(value => typeof value !== 'string')) {
      compatibility.push(diagnostic(
        'compatibility',
        'RUN_ARTIFACT',
        'RUN_TRACE_PATHS_MISSING',
        `completed trial ${caseId}#${trial} has no usable tracePaths; imported or aggregate-only runs cannot prove a multi-session contract`,
        { caseId, trial },
      ))
      continue
    }
    if (rawPaths.length > MAX_TRACE_PATHS_PER_TRIAL) {
      compatibility.push(diagnostic(
        'compatibility',
        'RUN_ARTIFACT',
        'RUN_TRACE_PATHS_EXCESSIVE',
        `completed trial ${caseId}#${trial} declares ${rawPaths.length} trace paths; the safety limit is ${MAX_TRACE_PATHS_PER_TRIAL}`,
        { caseId, trial },
      ))
      continue
    }
    if (rawPaths.some(remoteOrDevicePath)) {
      compatibility.push(diagnostic(
        'compatibility',
        'RUN_ARTIFACT',
        'RUN_TRACE_REMOTE_PATH',
        `completed trial ${caseId}#${trial} declares a remote or device-style trace path, which is not read`,
        { caseId, trial },
      ))
      continue
    }
    const paths = [...new Set(rawPaths.map(value => isAbsolute(value) ? value : resolve(baseDir, value)))]
    try {
      const sizes = await Promise.all(paths.map(async path => (await stat(path)).size))
      if (sizes.some(size => size > MAX_TRACE_BYTES) || sizes.reduce((sum, size) => sum + size, 0) > MAX_TRIAL_TRACE_BYTES) {
        compatibility.push(diagnostic(
          'compatibility',
          'RUN_ARTIFACT',
          'RUN_TRACE_SIZE_EXCESSIVE',
          `completed trial ${caseId}#${trial} exceeds the local trace-size safety limit`,
          { caseId, trial },
        ))
        continue
      }
      const sessions = await Promise.all(paths.map(loadSessionLog))
      trials.push({ caseId, trial, status: 'completed', sessions })
    } catch (error) {
      compatibility.push(diagnostic(
        'compatibility',
        'RUN_ARTIFACT',
        'RUN_TRACE_UNREADABLE',
        `failed to read one or more trace logs under ${basename(dirname(paths[0]))}`,
        { caseId, trial },
      ))
    }
  }
  return { trials, compatibility }
}
