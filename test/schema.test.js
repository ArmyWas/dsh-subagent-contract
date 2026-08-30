import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import { verifyRun } from '../src/index.js'

const root = dirname(fileURLToPath(import.meta.url))
const schema = JSON.parse(await readFile(join(root, '..', 'schemas', 'report.schema.json'), 'utf8'))
const validate = new Ajv2020({ allErrors: true }).compile(schema)

test('machine report conforms to the published JSON Schema', async () => {
  const report = await verifyRun(join(root, 'fixtures', 'pass', 'run.json'))
  assert.equal(validate(report), true, JSON.stringify(validate.errors))
})
