import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
const appConfig = JSON.parse(readFileSync(path.join(frontendRoot, 'tsconfig.json'), 'utf8'))
const nodeConfig = JSON.parse(readFileSync(path.join(frontendRoot, 'tsconfig.node.json'), 'utf8'))
const { default: eslintConfig } = await import('../eslint.config.js')
const tscPath = path.join(frontendRoot, 'node_modules', 'typescript', 'bin', 'tsc')

function normalizedConfigPath(configPath) {
  return configPath.replaceAll('\\', '/')
}

function runProbe(baseConfig, source) {
  // Keep the temporary project under the frontend root so package type
  // resolution follows the same node_modules ancestry as the real projects.
  // The cache directory is ignored by linters and build tooling, avoiding a
  // race when independent CI jobs run checks concurrently.
  const probeCacheDir = path.join(frontendRoot, 'node_modules', '.cache')
  mkdirSync(probeCacheDir, { recursive: true })
  const probeDir = mkdtempSync(path.join(probeCacheDir, 'candlescope-types-'))
  try {
    writeFileSync(path.join(probeDir, 'probe.ts'), source)
    writeFileSync(path.join(probeDir, 'tsconfig.json'), JSON.stringify({
      extends: normalizedConfigPath(baseConfig),
      compilerOptions: { noEmit: true },
      include: ['probe.ts'],
      exclude: [],
    }))

    try {
      execFileSync(process.execPath, [tscPath, '--pretty', 'false', '-p', path.join(probeDir, 'tsconfig.json')], {
        cwd: frontendRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      return { status: 0, output: '' }
    } catch (error) {
      return {
        status: error.status ?? 1,
        output: `${error.stdout ?? ''}${error.stderr ?? ''}`,
      }
    }
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }
}

test('test commands discover nested and colocated TypeScript tests', () => {
  assert.ok(
    packageJson.scripts.test.includes('src/**/*.test.{ts,tsx}'),
    'test must discover every .test.ts and .test.tsx file below src',
  )
  assert.ok(
    packageJson.scripts['test:drawing'].includes('src/features/drawings/**/*.test.{ts,tsx}'),
    'test:drawing must discover nested and colocated drawing tests',
  )
})

test('the browser project excludes Node ambient types', () => {
  assert.deepEqual(appConfig.compilerOptions.types, ['vite/client'])
  assert.ok(appConfig.exclude.includes('src/**/__tests__/**'))

  const result = runProbe(
    path.join(frontendRoot, 'tsconfig.json'),
    'void process; void Buffer; void setImmediate;',
  )

  assert.notEqual(result.status, 0)
  assert.match(result.output, /Cannot find name 'process'/)
  assert.match(result.output, /Cannot find name 'Buffer'/)
  assert.match(result.output, /Cannot find name 'setImmediate'/)
})

test('the Node project retains Node types for tests and tooling', () => {
  assert.ok(nodeConfig.compilerOptions.types.includes('node'))

  const result = runProbe(
    path.join(frontendRoot, 'tsconfig.node.json'),
    "import test from 'node:test'; test('node ambient types', () => { void process; void Buffer; void setImmediate; });",
  )

  assert.equal(result.status, 0, result.output)
})

test('ESLint keeps Node globals out of production TypeScript', () => {
  const productionTypescriptConfig = eslintConfig.find((config) => (
    config.files?.includes('**/*.{ts,tsx}')
    && config.languageOptions?.parserOptions?.project?.includes('./tsconfig.json')
  ))
  const nodeTypescriptConfig = eslintConfig.find((config) => (
    config.files?.includes('src/**/*.test.{ts,tsx}')
  ))

  assert.ok(productionTypescriptConfig)
  assert.ok(nodeTypescriptConfig)
  for (const globalName of ['process', 'Buffer', 'setImmediate']) {
    assert.equal(globalName in productionTypescriptConfig.languageOptions.globals, false)
    assert.equal(globalName in nodeTypescriptConfig.languageOptions.globals, true)
  }
  assert.deepEqual(productionTypescriptConfig.languageOptions.parserOptions.project, ['./tsconfig.json'])
  assert.deepEqual(nodeTypescriptConfig.languageOptions.parserOptions.project, ['./tsconfig.node.json'])
})
