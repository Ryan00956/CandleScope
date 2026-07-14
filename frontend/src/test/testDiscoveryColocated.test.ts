import assert from 'node:assert/strict'
import test from 'node:test'

test('npm test discovers TypeScript tests outside __tests__ directories', () => {
  assert.equal('colocated'.toUpperCase(), 'COLOCATED')
})
