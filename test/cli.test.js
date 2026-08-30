import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(fileURLToPath(import.meta.url))
const cli = join(root, '..', 'bin', 'dsh-subagent-contract.js')
const run = join(root, 'fixtures', 'pass', 'run.json')

test('CLI emits machine-readable output and preserves exit code', () => {
  const result = spawnSync(process.execPath, [cli, 'verify', run, '--format=json'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const parsed = JSON.parse(result.stdout)
  assert.equal(parsed.tool, 'dsh-subagent-contract')
  assert.equal(parsed.contract, 'dsh-subagent/v0.1')
})

test('pretty output reports an inconclusive verdict and diagnostic location', () => {
  const result = spawnSync(process.execPath, [cli, 'verify', join(root, 'fixtures', 'pass', 'run.json')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /trials: 4 passed, 0 failed, 0 inconclusive/u)
})

test('CLI prints its version', () => {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '0.1.0-preview.1')
})

test('CLI initializes the fixed benchmark and refuses to overwrite it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-subagent-contract-init-'))
  const destination = join(directory, 'probe.yml')
  const first = spawnSync(process.execPath, [cli, 'init', destination], { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  await access(destination)
  const second = spawnSync(process.execPath, [cli, 'init', destination], { encoding: 'utf8' })
  assert.equal(second.status, 2)
  assert.match(second.stderr, /refusing to overwrite/u)
})
