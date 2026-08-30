import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const root = dirname(fileURLToPath(import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-subagent-contract-sdk-smoke-'))
const dshHome = join(temporary, 'dsh-home')
const workspace = join(temporary, 'workspace')
await mkdir(dshHome, { recursive: true })
await mkdir(workspace, { recursive: true })
const client = new HarnessClient({
  profile: 'sdk',
  patches: [join(root, 'trial-overlay.cordis.yml'), join(root, 'no-report.cordis.yml'), join(root, 'no-control.cordis.yml')],
  dshHome,
  processCwd: workspace,
  env: {
    ...scrubbedParentEnv(),
    DEEPSEEK_API_KEY: 'sdk-smoke-placeholder-not-a-real-credential',
    DSH_TELEMETRY_DISABLED: '1',
  },
  initializeTimeoutMs: 30_000,
  requestTimeoutMs: 5_000,
  shutdownTimeoutMs: 5_000,
})

try {
  client.start()
  const initialized = await client.initialize({
    cwd: workspace,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    maxTokens: 256,
  })
  assert.equal(initialized.serverInfo.name, 'deepseek-harness-sdk-runtime')
  assert.equal(typeof initialized.serverInfo.version, 'string')
} finally {
  await client.close()
  await rm(temporary, { recursive: true, force: true })
}
