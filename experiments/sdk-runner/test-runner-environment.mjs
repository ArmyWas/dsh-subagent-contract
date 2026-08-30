import assert from 'node:assert/strict'
import test from 'node:test'
import { publicDeepSeekEnvironment } from './runner-environment.mjs'

test('removes every case variant of inherited DeepSeek endpoint routing', () => {
  const source = {
    PATH: 'safe-path',
    DEEPSEEK_BASE_URL: 'https://first.invalid',
    DeepSeek_Base_Url: 'https://second.invalid',
    deepseek_base_url: 'https://third.invalid',
  }
  const result = publicDeepSeekEnvironment(source, 'test-only-key')
  assert.deepEqual(result, {
    PATH: 'safe-path',
    DEEPSEEK_API_KEY: 'test-only-key',
    DSH_TELEMETRY_DISABLED: '1',
  })
  assert.equal(source.DeepSeek_Base_Url, 'https://second.invalid')
})

test('rejects invalid inputs without creating a partial environment', () => {
  assert.throws(() => publicDeepSeekEnvironment(null, 'key'), TypeError)
  assert.throws(() => publicDeepSeekEnvironment({}, '  '), TypeError)
})
