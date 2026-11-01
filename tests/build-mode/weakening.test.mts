import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error plain ESM hook module without types
import { removedAssertions } from '../../build-mode/template/.claude/hooks/lib/weakening.mjs'

const lost = (before: string, after: string): string[] => removedAssertions(before, after)

test('identical text loses nothing', () => {
  assert.deepEqual(lost('assert f(1) == 2\n', 'assert f(1) == 2\n'), [])
})

test('a deleted assertion is lost', () => {
  assert.deepEqual(lost('x = 1\nassert x == 1\n', 'x = 1\n'), ['assert x == 1'])
})

test('a loosened assertion is lost', () => {
  assert.deepEqual(lost('assert f() == 3\n', 'assert f()\n'), ['assert f() == 3'])
})

test('a commented-out assertion is lost', () => {
  assert.deepEqual(lost('assert f() == 3\n', '# assert f() == 3\n'), ['assert f() == 3'])
})

test('whitespace and indentation changes are not weakening', () => {
  assert.deepEqual(lost('    assert  f() == 3\n', 'assert f() == 3\n'), [])
})

test('moving an assertion elsewhere in the file is not weakening', () => {
  assert.deepEqual(lost('assert a == 1\nassert b == 2\n', 'assert b == 2\nassert a == 1\n'), [])
})

test('two identical assertions need two in the result', () => {
  assert.deepEqual(lost('assert a == 1\nassert a == 1\n', 'assert a == 1\n'), ['assert a == 1'])
})

test('added assertions and added tests are fine', () => {
  assert.deepEqual(lost('assert a == 1\n', 'assert a == 1\nassert b == 2\ndef test_new(): assert c\n'), [])
})

test('javascript expectations and python raises count as assertions', () => {
  assert.deepEqual(lost('expect(f()).toBe(3)\nwith pytest.raises(ValueError):\n', ''), ['expect(f()).toBe(3)', 'with pytest.raises(ValueError):'])
})

test('lines that are not assertions are ignored', () => {
  assert.deepEqual(lost('x = compute()\nprint(x)\n', ''), [])
})
