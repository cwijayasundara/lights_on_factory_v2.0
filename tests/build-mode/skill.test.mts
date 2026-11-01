import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '../../build-mode')
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

test('the skill states every rule the hook relies on', () => {
  const skill = read('template/.claude/skills/build-discipline/SKILL.md')
  assert.match(skill, /^---\nname: build-discipline\ndescription: .+\n---\n/)
  for (const rule of ['DECISIONS.md', 'BLOCKED.md', '[!]', 'verify:', 'after:', 'done:', 'blocked:', 'BUILD-REPORT.md', 'git push origin main', 'never loosen', 'accepted-mutants.md', 'mutate.py --changed']) {
    assert.ok(skill.toLowerCase().includes(rule.toLowerCase()), `SKILL.md is missing "${rule}"`)
  }
  for (const header of ['COMPLETE', 'PARTIAL', 'STALLED']) assert.ok(skill.includes(header), `SKILL.md is missing header ${header}`)
  assert.ok(skill.split('\n').length < 150, 'SKILL.md should stay under 150 lines')
})

test('the build prompt is the fixed text', () => {
  assert.equal(
    read('template/.factory/build-prompt.txt').trim(),
    'Build this project. Invoke the build-discipline skill first. SPEC.md is the approved spec. If PLAN.md does not exist, write it; otherwise continue it. Never ask the operator anything. Keep going until the Stop hook lets you stop.',
  )
})

test('the notice credits pstack under MIT and says no ub-mode text is included', () => {
  const notice = read('NOTICE.md')
  for (const word of ['pstack', 'MIT', 'Lauren Tan', 'ub-mode']) assert.ok(notice.includes(word), `NOTICE.md is missing "${word}"`)
  assert.match(notice, /ub-mode[^\n]*not (copied|included)/)
})
