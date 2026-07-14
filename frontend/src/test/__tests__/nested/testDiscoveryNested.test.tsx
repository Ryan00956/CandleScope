import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

test('npm test discovers nested TSX test files', () => {
  const element = <span data-test-kind="nested-tsx">TSX discovery</span>

  assert.equal(element.type, 'span')
  assert.equal(element.props['data-test-kind'], 'nested-tsx')
  assert.equal(element.props.children, 'TSX discovery')
})
