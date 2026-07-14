import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { ESLint } from 'eslint'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'))
const appConfig = JSON.parse(readFileSync(path.join(frontendRoot, 'tsconfig.json'), 'utf8'))
const nodeConfig = JSON.parse(readFileSync(path.join(frontendRoot, 'tsconfig.node.json'), 'utf8'))
const tscPath = path.join(frontendRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const unsafeRuleNames = [
  '@typescript-eslint/no-unsafe-argument',
  '@typescript-eslint/no-unsafe-assignment',
  '@typescript-eslint/no-unsafe-call',
  '@typescript-eslint/no-unsafe-enum-comparison',
  '@typescript-eslint/no-unsafe-member-access',
  '@typescript-eslint/no-unsafe-return',
]

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

test('both TypeScript projects enforce strict indexed and optional-property semantics', () => {
  assert.equal(appConfig.compilerOptions.noUncheckedIndexedAccess, true)
  assert.equal(appConfig.compilerOptions.exactOptionalPropertyTypes, true)
  assert.equal(nodeConfig.extends, './tsconfig.json')

  const strictnessProbe = `
    const values: number[] = [];
    values[0].toFixed();
    interface Options { optional?: string }
    const options: Options = { optional: undefined };
    void options;
  `
  for (const configName of ['tsconfig.json', 'tsconfig.node.json']) {
    const result = runProbe(path.join(frontendRoot, configName), strictnessProbe)
    assert.notEqual(result.status, 0, `${configName} unexpectedly accepted the strictness probe`)
    assert.match(result.output, /error TS2532:/, `${configName} did not enforce noUncheckedIndexedAccess`)
    assert.match(result.output, /error TS2375:/, `${configName} did not enforce exactOptionalPropertyTypes`)
  }
})

test('ESLint keeps Node globals scoped and unsafe type boundaries enabled', async () => {
  const eslint = new ESLint({ cwd: frontendRoot })
  const productionTypescriptConfig = await eslint.calculateConfigForFile('src/main.tsx')
  const nodeConfigFiles = [
    'src/test/testDiscoveryColocated.test.ts',
    'src/test/__tests__/nested/testDiscoveryNested.test.tsx',
    'src/services/__tests__/api.test.ts',
    'scripts/smoke.ts',
  ]
  const nodeTypescriptConfigs = await Promise.all(
    nodeConfigFiles.map((file) => eslint.calculateConfigForFile(file)),
  )

  for (const globalName of ['process', 'Buffer', 'setImmediate']) {
    assert.equal(globalName in productionTypescriptConfig.languageOptions.globals, false)
    for (const effectiveConfig of nodeTypescriptConfigs) {
      assert.equal(globalName in effectiveConfig.languageOptions.globals, true)
    }
  }
  assert.deepEqual(productionTypescriptConfig.languageOptions.parserOptions.project, ['./tsconfig.json'])
  for (const effectiveConfig of nodeTypescriptConfigs) {
    assert.deepEqual(effectiveConfig.languageOptions.parserOptions.project, ['./tsconfig.node.json'])
  }
  for (const [file, effectiveConfig] of [
    ['src/main.tsx', productionTypescriptConfig],
    ...nodeConfigFiles.map((file, index) => [file, nodeTypescriptConfigs[index]]),
  ]) {
    for (const ruleName of unsafeRuleNames) {
      assert.equal(
        effectiveConfig.rules[ruleName]?.[0],
        2,
        `${ruleName} must remain an error for ${file}`,
      )
    }
  }
})
