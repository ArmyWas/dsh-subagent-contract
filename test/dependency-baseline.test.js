import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const reviewedRuntime = Object.freeze({
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/dsh-session': '0.1.5-rc.3',
  '@deepseek-ai/dsh-session-format-catalog': '0.1.5-rc.3',
})

const lockSecurityFloors = Object.freeze({
  'fast-uri': '3.1.9',
  zod: '4.6.6',
})

const ignoredVersionUpdateTypes = new Set([
  'version-update:semver-patch',
  'version-update:semver-minor',
  'version-update:semver-major',
])

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

function stableTuple(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/u, 'security floor requires stable lock metadata')
  return version.split('.').map(Number)
}

function assertAtLeast(version, floor, name) {
  const installed = stableTuple(version)
  const minimum = stableTuple(floor)
  const firstDifference = installed.findIndex((value, index) => value !== minimum[index])
  assert.ok(firstDifference === -1 || installed[firstDifference] > minimum[firstDifference], `${name} is below ${floor}`)
}

export function assertReviewedRuntime(manifest, lock) {
  assert.deepEqual(
    Object.fromEntries(Object.keys(reviewedRuntime).map((name) => [name, manifest.dependencies?.[name]])),
    reviewedRuntime,
    'package.json must use the reviewed runtime tuple',
  )
  assert.deepEqual(
    Object.fromEntries(Object.keys(reviewedRuntime).map((name) => [name, lock.packages?.['']?.dependencies?.[name]])),
    reviewedRuntime,
    'the lockfile root must use the reviewed runtime tuple',
  )

  for (const [name, version] of Object.entries(reviewedRuntime)) {
    assert.equal(
      lock.packages?.[`node_modules/${name}`]?.version,
      version,
      `the lockfile entry for ${name} must match the reviewed runtime tuple`,
    )
  }

  const cordisPeers = Object.entries(lock.packages ?? {}).filter(
    ([path, entry]) =>
      path.startsWith('node_modules/@deepseek-ai/') &&
      Object.hasOwn(entry.peerDependencies ?? {}, '@deepseek-ai/cordis'),
  )
  assert.ok(cordisPeers.length > 0, 'the reviewed graph must expose applicable Cordis peer constraints')
  for (const [path, entry] of cordisPeers) {
    assert.equal(
      entry.peerDependencies['@deepseek-ai/cordis'],
      reviewedRuntime['@deepseek-ai/cordis'],
      `${path} must require the reviewed exact Cordis peer`,
    )
  }
}

// This deliberately recognizes only the small repository policy shape below;
// it is not a general YAML parser or a substitute for GitHub's config validation.
export function readRepositoryIgnoreRules(text) {
  const rules = new Map()
  let current
  for (const line of text.split(/\r?\n/)) {
    const dependency = line.match(/^      - dependency-name: ["']([^"']+)["']\s*$/)
    if (dependency) {
      current = { updateTypes: new Set(), hasVersions: false }
      rules.set(dependency[1], current)
      continue
    }
    if (!current) continue
    if (/^        versions:/.test(line)) current.hasVersions = true
    const updateType = line.match(/^          - ["'](version-update:semver-(?:patch|minor|major))["']\s*$/)
    if (updateType) current.updateTypes.add(updateType[1])
    if (/^      - /.test(line) && !dependency) current = undefined
  }
  return rules
}

export function assertRepositoryPolicy(text) {
  const rules = readRepositoryIgnoreRules(text)
  assert.deepEqual([...rules.keys()].sort(), Object.keys(reviewedRuntime).sort())
  assert.equal([...rules.keys()].some((name) => name.includes('*')), false, 'broad wildcard ignores are forbidden')
  for (const [name, rule] of rules) {
    assert.equal(rule.hasVersions, false, `${name} must not use ignore.versions`)
    assert.deepEqual(rule.updateTypes, ignoredVersionUpdateTypes, `${name} must ignore all routine SemVer update types`)
  }
}

test('manifest and lockfile preserve the reviewed runtime tuple and exact Cordis peers', () => {
  assertReviewedRuntime(readJson('../package.json'), readJson('../package-lock.json'))
})

test('root lock metadata meets reviewed dependency security floors', () => {
  const lock = readJson('../package-lock.json')
  for (const [name, floor] of Object.entries(lockSecurityFloors)) {
    const entry = lock.packages?.[`node_modules/${name}`]
    assert.ok(entry, `missing lock metadata for ${name}`)
    assertAtLeast(entry.version, floor, name)
  }
  assert.equal(lock.packages['node_modules/fast-uri'].dev, true, 'fast-uri must remain a development-only lock node')
})

test('independent Cordis drift is rejected', () => {
  const manifest = structuredClone(readJson('../package.json'))
  manifest.dependencies['@deepseek-ai/cordis'] = '4.0.5'
  assert.throws(
    () => assertReviewedRuntime(manifest, readJson('../package-lock.json')),
    /package\.json must use the reviewed runtime tuple/,
  )
})

test('Dependabot policy has three exact version-update-only rules', () => {
  assertRepositoryPolicy(readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8'))
})

test('Dependabot policy mutation loses coverage', () => {
  const policy = readFileSync(new URL('../.github/dependabot.yml', import.meta.url), 'utf8')
  assert.throws(
    () => assertRepositoryPolicy(policy.replace('          - "version-update:semver-major"', '')),
    /must ignore all routine SemVer update types/,
  )
})
