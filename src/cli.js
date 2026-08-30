import { constants, readFileSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyRun } from './index.js'

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const HELP = `dsh-subagent-contract

Usage:
  dsh-subagent-contract init [benchmark.yml]
  dsh-subagent-contract verify <run.json> [--format pretty|json]
  dsh-subagent-contract --version

Exit codes:
  0  all verifiable contracts passed
  1  one or more contract violations
  2  input or compatibility error; the result is not reliable
`

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { help: true }
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) return { version: true }
  if (argv[0] === 'init' && argv.length <= 2) return { init: true, destination: argv[1] ?? 'subagent-contract-v0.1.yml' }
  if (argv[0] !== 'verify' || typeof argv[1] !== 'string') throw new Error(HELP.trim())
  let format = 'pretty'
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index].startsWith('--format=')) {
      const value = argv[index].slice('--format='.length)
      if (!['pretty', 'json'].includes(value)) throw new Error(`unknown format: ${value}\n\n${HELP}`)
      format = value
      continue
    }
    if (argv[index] === '--format' && ['pretty', 'json'].includes(argv[index + 1])) {
      format = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argv[index]}\n\n${HELP}`)
  }
  return { help: false, runPath: argv[1], format }
}

function pretty(result) {
  const icon = result.exitCode === 0 ? 'PASS' : result.exitCode === 1 ? 'FAIL' : 'INCONCLUSIVE'
  const lines = [
    `${icon} ${result.contract}`,
    `benchmark: ${result.source.benchmark}`,
    `trials: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.inconclusive} inconclusive, ${result.summary.skipped} skipped`,
    `diagnostics: ${result.summary.violations} violations, ${result.summary.compatibilityErrors} compatibility errors`,
  ]
  for (const item of [...result.violations, ...result.compatibility]) {
    const location = [
      typeof item.caseId === 'string' ? item.caseId : undefined,
      Number.isSafeInteger(item.trial) ? `trial=${item.trial}` : undefined,
      typeof item.sessionId === 'string' ? `session=${item.sessionId}` : undefined,
    ].filter(Boolean).join(' ')
    lines.push(`${item.code}${location === '' ? '' : ` [${location}]`} ${item.message}`)
  }
  return lines.join('\n')
}

export async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (args.help) {
    console.log(HELP.trim())
    return 0
  }
  if (args.version) {
    console.log(VERSION)
    return 0
  }
  if (args.init) {
    const destination = resolve(args.destination)
    try {
      await copyFile(new URL('../benchmarks/subagent-v0.1.yml', import.meta.url), destination, constants.COPYFILE_EXCL)
      console.log(`wrote ${destination}`)
      return 0
    } catch (error) {
      if (error?.code === 'EEXIST') console.error(`refusing to overwrite existing file: ${destination}`)
      else console.error(error instanceof Error ? error.message : String(error))
      return 2
    }
  }
  try {
    const result = await verifyRun(args.runPath)
    console.log(args.format === 'json' ? JSON.stringify(result, null, 2) : pretty(result))
    return result.exitCode
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
}
