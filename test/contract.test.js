import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadRunArtifact, loadTrialTraceSets, verifyRun, verifyTrial } from '../src/index.js'

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pass')

async function fixtureCopy(prefix) {
  const root = await mkdtemp(join(tmpdir(), `dsh-subagent-contract-${prefix}-`))
  await cp(fixture, root, { recursive: true })
  return root
}

async function replaceIn(path, before, after) {
  const text = await readFile(path, 'utf8')
  assert.ok(text.includes(before), `fixture mutation target not found: ${before}`)
  await writeFile(path, text.replace(before, after))
}

async function loadedTrial(caseId) {
  const runPath = join(fixture, 'run.json')
  const run = await loadRunArtifact(runPath)
  const loaded = await loadTrialTraceSets(runPath, run)
  return loaded.trials.find(item => item.caseId === caseId)
}

test('accepts the complete four-scenario bundled matrix', async () => {
  const result = await verifyRun(join(fixture, 'run.json'))
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.violations, [])
  assert.deepEqual(result.compatibility, [])
  assert.equal(result.summary.verified, 4)
  assert.equal(result.summary.passed, 4)
  assert.deepEqual(result.coverage.map(item => item.scenarioStatus), Array(4).fill('exercised'))
})

test('labels a self-declared persistent SDK runner artifact as a claim', async () => {
  const root = await fixtureCopy('sdk-producer')
  const runPath = join(root, 'run.json')
  const run = JSON.parse(await readFile(runPath, 'utf8'))
  run.producer = 'dsh-subagent-contract-sdk-runner'
  await writeFile(runPath, JSON.stringify(run))
  const result = await verifyRun(runPath)
  assert.equal(result.source.kind, 'sdk-runner-claim')
})

test('reports an exact depth mismatch as a contract violation', async () => {
  const root = await fixtureCopy('depth')
  const child = join(root, 'foreground-child', 'session.jsonl')
  await replaceIn(child, '"delegationDepth":1', '"delegationDepth":2')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 1)
  const failure = result.violations.find(item => item.code === 'C01_DEPTH_MISMATCH')
  assert.equal(failure?.message, 'child=c-foreground depth=2 parent=p-foreground depth=0 expected=1')
})

test('treats an unknown descriptor version as compatibility drift', async () => {
  const root = await fixtureCopy('version')
  const child = join(root, 'foreground-child', 'session.jsonl')
  await replaceIn(child, '"version":3,"mode":"one-shot"', '"version":99,"mode":"one-shot"')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'C02_UNSUPPORTED_DESCRIPTOR_VERSION'))
})

test('detects explicit reports attributed to the wrong child', async () => {
  const root = await fixtureCopy('report-sender')
  const parent = join(root, 'report-parent', 'session.jsonl')
  await replaceIn(parent, '"kind":"subagent-report","form":"relay","senderSessionId":"c-report"', '"kind":"subagent-report","form":"relay","senderSessionId":"wrong-child"')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 1)
  assert.ok(result.violations.some(item => item.code === 'C07_SENDER_UNRESOLVED'))
})

test('detects settlement notifications attributed to a non-child sender', async () => {
  const root = await fixtureCopy('settlement-sender')
  const parent = join(root, 'continuable-parent', 'session.jsonl')
  await replaceIn(
    parent,
    '"kind":"subagent-settled","form":"notice","summary":"Background subagent c-fifo finished.","senderSessionId":"c-fifo"',
    '"kind":"subagent-settled","form":"notice","summary":"Background subagent c-fifo finished.","senderSessionId":"wrong-child"',
  )
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.violations.some(item => item.code === 'C06_SENDER_UNRESOLVED'))
  assert.ok(result.compatibility.some(item => item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('treats an open foreground child log as incomplete evidence', async () => {
  const root = await fixtureCopy('terminal')
  const child = join(root, 'foreground-child', 'session.jsonl')
  await replaceIn(child, '{"type":"turn/end","seq":5,"time":5,"data":{"reason":{"kind":"completed"}}}\r\n', '')
    .catch(async () => replaceIn(child, '{"type":"turn/end","seq":5,"time":5,"data":{"reason":{"kind":"completed"}}}\n', ''))
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRACE_UNSETTLED'))
  assert.ok(!result.violations.some(item => item.code === 'C04_TERMINAL_MISSING'))
})

test('completed foreground plus an error result is inconclusive, not a behavior violation', async () => {
  const trial = await loadedTrial('foreground-success')
  trial.caseId = 'generic-foreground'
  const parent = trial.sessions.find(session => session.header.id === 'p-foreground')
  const resultEvent = parent.ownEvents.find(event => event.type === 'tool/result')
  resultEvent.data.message.content[0].isError = true
  const result = verifyTrial(trial)
  assert.ok(result.compatibility.some(item => item.code === 'C04_COMPLETED_ERROR_AMBIGUOUS'))
  assert.ok(!result.violations.some(item => item.contract === 'C04_FOREGROUND_OUTCOME'))
  assert.ok(!result.violations.some(item => item.code === 'C03_UNACCOUNTED_CHILD'))
})

test('a failed foreground execution may retain one durable child', async () => {
  const trial = await loadedTrial('foreground-success')
  trial.caseId = 'generic-foreground-error'
  const parent = trial.sessions.find(session => session.header.id === 'p-foreground')
  const child = trial.sessions.find(session => session.header.id === 'c-foreground')
  parent.ownEvents.find(event => event.type === 'tool/result').data.message.content[0].isError = true
  child.ownEvents.find(event => event.type === 'turn/end').data.reason.kind = 'error'
  const result = verifyTrial(trial)
  assert.ok(!result.violations.some(item => item.contract === 'C03_ADMISSION_CARDINALITY'))
  assert.ok(!result.violations.some(item => item.contract === 'C04_FOREGROUND_OUTCOME'))
})

test('rejects duplicate subagent call ids', async () => {
  const trial = await loadedTrial('two-admissions')
  trial.caseId = 'generic-two-admissions'
  const parent = trial.sessions.find(session => session.header.id === 'p-admission')
  const second = parent.ownEvents.filter(event => event.type === 'tool/call')[1]
  second.data.callId = 'call-admission-a'
  const result = verifyTrial(trial)
  assert.ok(result.violations.some(item => item.code === 'C03_DUPLICATE_CALL_ID'))
})

test('rejects duplicate send_message call ids', async () => {
  const root = await fixtureCopy('send-call-id')
  const parent = join(root, 'continuable-parent', 'session.jsonl')
  await replaceIn(parent, '"callId":"send-fifo-2","name":"send_message"', '"callId":"send-fifo-1","name":"send_message"')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 1)
  assert.ok(result.violations.some(item => item.code === 'C05_DUPLICATE_CALL_ID'))
})

test('two-admissions requires durable integer turn and step coordinates', async () => {
  const root = await fixtureCopy('admission-coordinates')
  const parent = join(root, 'admission-parent', 'session.jsonl')
  const text = await readFile(parent, 'utf8')
  await writeFile(parent, text.replaceAll('"turn":1,"step":1,', ''))
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.caseId === 'two-admissions' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('marks fixed FIFO probes that do not wait for each settlement inconclusive', async () => {
  const root = await fixtureCopy('fifo-order')
  const parent = join(root, 'continuable-parent', 'session.jsonl')
  const lines = (await readFile(parent, 'utf8')).trimEnd().split(/\r?\n/u)
  const notice = lines.splice(3, 1)[0]
  lines.splice(5, 0, notice)
  await writeFile(parent, `${lines.join('\n')}\n`)
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.caseId === 'continuable-fifo' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('requires the fixed FIFO probe to persist an explicit background mode', async () => {
  const root = await fixtureCopy('fifo-explicit-mode')
  const parent = join(root, 'continuable-parent', 'session.jsonl')
  await replaceIn(parent, ',\\\"run_in_background\\\":true', '')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'C03_MODE_UNSPECIFIED'))
  assert.ok(result.compatibility.some(item => item.caseId === 'continuable-fifo' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('does not silently accept an extra direct child from an unsupported provider', async () => {
  const root = await fixtureCopy('rogue-provider-child')
  const rogueDirectory = join(root, 'rogue-child')
  await cp(join(root, 'foreground-child'), rogueDirectory, { recursive: true })
  const rogue = join(rogueDirectory, 'session.jsonl')
  await replaceIn(rogue, '\"id\":\"c-foreground\"', '\"id\":\"c-rogue\"')
  await replaceIn(rogue, '\"provider\":\"spawn\"', '\"provider\":\"fork\"')
  await replaceIn(rogue, '\"label\":\"contract:foreground-success\"', '\"label\":\"rogue:fork\"')
  const runPath = join(root, 'run.json')
  const run = JSON.parse(await readFile(runPath, 'utf8'))
  run.cases.find(item => item.caseId === 'foreground-success').tracePaths.push('rogue-child/session.jsonl')
  await writeFile(runPath, JSON.stringify(run))
  const result = await verifyRun(runPath)
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'C03_PROVIDER_UNSUPPORTED'))
  assert.ok(result.compatibility.some(item => item.caseId === 'foreground-success' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('fixed FIFO proves each coordinator message starts the next closed turn', async () => {
  const root = await fixtureCopy('fifo-child-order')
  const child = join(root, 'continuable-child', 'session.jsonl')
  const lines = (await readFile(child, 'utf8')).trimEnd().split(/\r?\n/u)
  const secondMessageIndex = lines.findIndex(line => line.includes('"text":"SECOND"'))
  const secondMessage = lines.splice(secondMessageIndex, 1)[0]
  const firstMessageIndex = lines.findIndex(line => line.includes('"text":"FIRST"'))
  lines.splice(firstMessageIndex + 1, 0, secondMessage)
  await writeFile(child, `${lines.join('\n')}\n`)
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.caseId === 'continuable-fifo' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('open child activity is inconclusive rather than a false terminal violation', async () => {
  const root = await fixtureCopy('continuable-terminals')
  for (const relative of [join('continuable-child', 'session.jsonl'), join('report-child', 'session.jsonl')]) {
    const path = join(root, relative)
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/u).filter(line => !line.includes('"type":"turn/end"'))
    await writeFile(path, lines.join('\n'))
  }
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.filter(item => item.code === 'S00_SCENARIO_NOT_EXERCISED').length >= 2)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRACE_UNSETTLED'))
  assert.ok(!result.violations.some(item => item.code === 'C05_TERMINAL_COUNT'))
})

test('fixed cases require a completed root turn', async () => {
  const root = await fixtureCopy('root-terminal')
  const parent = join(root, 'foreground-parent', 'session.jsonl')
  const lines = (await readFile(parent, 'utf8')).split(/\r?\n/u).filter(line => !line.includes('"type":"turn/end"'))
  await writeFile(parent, lines.join('\n'))
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.caseId === 'foreground-success' && item.code === 'S00_SCENARIO_NOT_EXERCISED'))
})

test('detects report payload changes using the accepted message id', async () => {
  const root = await fixtureCopy('report-content')
  const parent = join(root, 'report-parent', 'session.jsonl')
  await replaceIn(parent, '"text":"CONTRACT-REPORT-OK"', '"text":"ALTERED"')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 1)
  assert.ok(result.violations.some(item => item.code === 'C07_REPORT_CONTENT_MISMATCH'))
})

test('settlement notices require a durable message id', async () => {
  const root = await fixtureCopy('settlement-id')
  const parent = join(root, 'report-parent', 'session.jsonl')
  await replaceIn(parent, ',"role":"user","id":"settled-report-1"', ',"role":"user"')
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 1)
  assert.ok(result.violations.some(item => item.code === 'C06_NOTICE_SHAPE'))
})

test('does not force a failed report result to have no relay', async () => {
  const trial = await loadedTrial('continuable-report')
  trial.caseId = 'generic-report-error-after-delivery'
  const child = trial.sessions.find(session => session.header.id === 'c-report')
  child.ownEvents.find(event => event.type === 'tool/result').data.message.content[0].isError = true
  const result = verifyTrial(trial)
  assert.ok(!result.violations.some(item => item.contract === 'C07_REPORT_PROVENANCE'))
})

test('direct verifyTrial callers receive compatibility drift for incomplete evidence', async () => {
  const trial = await loadedTrial('foreground-success')
  trial.sessions[0].incomplete = true
  const result = verifyTrial(trial)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRACE_INCOMPLETE'))
})

test('a missing bundled case makes the run inconclusive', async () => {
  const root = await fixtureCopy('matrix-missing')
  const runPath = join(root, 'run.json')
  const run = JSON.parse(await readFile(runPath, 'utf8'))
  run.cases = run.cases.slice(0, 1)
  await writeFile(runPath, JSON.stringify(run))
  const result = await verifyRun(runPath)
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_MATRIX_ENTRY_MISSING'))
})

test('one skipped bundled case cannot hide behind passing cases', async () => {
  const root = await fixtureCopy('trial-skipped')
  const runPath = join(root, 'run.json')
  const run = JSON.parse(await readFile(runPath, 'utf8'))
  run.cases.find(item => item.caseId === 'continuable-report').status = 'error'
  run.cases.find(item => item.caseId === 'continuable-report').error = 'probe failed to start'
  await writeFile(runPath, JSON.stringify(run))
  const result = await verifyRun(runPath)
  assert.equal(result.exitCode, 2)
  assert.equal(result.summary.skipped, 1)
  assert.equal(result.summary.inconclusive, 1)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRIAL_INCOMPLETE'))
})

test('structured diagnostics do not echo a skipped trial host error', async () => {
  const root = await fixtureCopy('trial-error-redaction')
  const runPath = join(root, 'run.json')
  const run = JSON.parse(await readFile(runPath, 'utf8'))
  const secret = 'PRIVATE-HOST-DIAGNOSTIC-DO-NOT-ECHO'
  run.cases[0] = { ...run.cases[0], status: 'error', error: secret }
  await writeFile(runPath, JSON.stringify(run))
  const result = await verifyRun(runPath)
  assert.equal(result.exitCode, 2)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('structured diagnostics do not echo ambiguous subagent descriptions', async () => {
  const trial = await loadedTrial('two-admissions')
  trial.caseId = 'generic-ambiguous-description'
  const parent = trial.sessions.find(session => session.header.id === 'p-admission')
  const secret = 'PRIVATE-SUBAGENT-DESCRIPTION-DO-NOT-ECHO'
  for (const call of parent.ownEvents.filter(event => event.type === 'tool/call')) {
    call.data.arguments = JSON.stringify({ description: secret, prompt: 'redacted', run_in_background: false })
  }
  const result = verifyTrial(trial)
  assert.ok(result.compatibility.some(item => item.code === 'C03_CORRELATION_AMBIGUOUS'))
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('rejects non-bundled and aggregate-only run artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subagent-contract-import-'))
  const run = {
    benchmark: 'import:codex',
    trials: 1,
    cases: [{ caseId: 'imported', trial: 1, status: 'completed', tracePath: 'one.jsonl', exitCode: 0, timedOut: false }],
  }
  await writeFile(join(root, 'run.json'), JSON.stringify(run))
  const result = await verifyRun(join(root, 'run.json'))
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_BENCHMARK_UNSUPPORTED'))
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRACE_PATHS_MISSING'))
})

test('refuses excessive, remote, and oversized trace inputs before reading them', async () => {
  const excessiveRoot = await fixtureCopy('trace-count-limit')
  const excessiveRunPath = join(excessiveRoot, 'run.json')
  const excessiveRun = JSON.parse(await readFile(excessiveRunPath, 'utf8'))
  excessiveRun.cases[0].tracePaths = Array.from({ length: 17 }, (_, index) => `missing-${index}.jsonl`)
  await writeFile(excessiveRunPath, JSON.stringify(excessiveRun))
  const excessive = await verifyRun(excessiveRunPath)
  assert.ok(excessive.compatibility.some(item => item.code === 'RUN_TRACE_PATHS_EXCESSIVE'))

  const remoteRoot = await fixtureCopy('trace-remote-limit')
  const remoteRunPath = join(remoteRoot, 'run.json')
  const remoteRun = JSON.parse(await readFile(remoteRunPath, 'utf8'))
  remoteRun.cases[0].tracePaths = ['\\\\server\\share\\session.jsonl']
  await writeFile(remoteRunPath, JSON.stringify(remoteRun))
  const remote = await verifyRun(remoteRunPath)
  assert.ok(remote.compatibility.some(item => item.code === 'RUN_TRACE_REMOTE_PATH'))

  const sizeRoot = await fixtureCopy('trace-size-limit')
  const sizeRunPath = join(sizeRoot, 'run.json')
  const oversizedPath = join(sizeRoot, 'oversized.jsonl')
  await writeFile(oversizedPath, '')
  await truncate(oversizedPath, 64 * 1024 * 1024 + 1)
  const sizeRun = JSON.parse(await readFile(sizeRunPath, 'utf8'))
  sizeRun.cases[0].tracePaths = ['oversized.jsonl']
  await writeFile(sizeRunPath, JSON.stringify(sizeRun))
  const oversized = await verifyRun(sizeRunPath)
  assert.ok(oversized.compatibility.some(item => item.code === 'RUN_TRACE_SIZE_EXCESSIVE'))
})

test('bounds the whole run matrix before iterating untrusted counts', async () => {
  const countRoot = await fixtureCopy('run-case-limit')
  const countRunPath = join(countRoot, 'run.json')
  const countRun = JSON.parse(await readFile(countRunPath, 'utf8'))
  countRun.cases = Array.from({ length: 65 }, () => countRun.cases[0])
  await writeFile(countRunPath, JSON.stringify(countRun))
  await assert.rejects(loadRunArtifact(countRunPath), /cases\[\] exceeds the 64-entry safety limit/u)

  const trialRoot = await fixtureCopy('run-trial-limit')
  const trialRunPath = join(trialRoot, 'run.json')
  const trialRun = JSON.parse(await readFile(trialRunPath, 'utf8'))
  trialRun.trials = Number.MAX_SAFE_INTEGER
  await writeFile(trialRunPath, JSON.stringify(trialRun))
  const result = await verifyRun(trialRunPath)
  assert.equal(result.exitCode, 2)
  assert.ok(result.compatibility.some(item => item.code === 'RUN_TRIAL_COUNT_EXCESSIVE'))
})
