import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error plain ESM hook module without types
import { untestedCommits } from '../../build-mode/template/.claude/hooks/lib/testfirst.mjs'

type Commit = { sha: string; subject: string; files: string[] }
const c = (sha: string, subject: string, ...files: string[]): Commit => ({ sha: sha.padEnd(7, '0'), subject, files })
const check = (commits: Commit[]): string[] => untestedCommits(commits, ['src'], ['tests/'])

test('code and tests in one commit is covered', () => {
  assert.deepEqual(check([c('a', 'feat: x', 'src/x.py', 'tests/test_x.py')]), [])
})

test('code with no tests anywhere afterwards is reported', () => {
  assert.deepEqual(check([c('a', 'feat: x', 'src/x.py')]), ['a000000 feat: x'])
})

test('a later commit with tests covers earlier code, so the agent can cure a finding', () => {
  assert.deepEqual(check([c('a', 'feat: x', 'src/x.py'), c('b', 'test: x', 'tests/test_x.py')]), [])
})

test('code after the last tests is reported, earlier covered code is not', () => {
  const commits = [c('a', 'feat: x', 'src/x.py', 'tests/test_x.py'), c('b', 'fix: y', 'src/y.py')]
  assert.deepEqual(check(commits), ['b000000 fix: y'])
})

test('refactor, chore, docs and style commits are exempt', () => {
  for (const subject of ['refactor: tidy', 'chore: deps', 'docs: readme', 'style: fmt', 'refactor(core): tidy']) {
    assert.deepEqual(check([c('a', subject, 'src/x.py')]), [], subject)
  }
})

test('commits that touch only tests, docs or plan files are never reported', () => {
  assert.deepEqual(check([c('a', 'feat: spec text', 'PLAN.md', 'README.md'), c('b', 'test: t', 'tests/t.py')]), [])
})

test('a path that only starts like a root is not under it', () => {
  assert.deepEqual(check([c('a', 'feat: x', 'srcs/x.py')]), [])
})

test('without sources or test paths the rule is off', () => {
  assert.deepEqual(untestedCommits([c('a', 'feat: x', 'src/x.py')], ['src'], []), [])
  assert.deepEqual(untestedCommits([c('a', 'feat: x', 'src/x.py')], [], ['tests/']), [])
})
