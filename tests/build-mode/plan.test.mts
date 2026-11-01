import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error plain ESM hook module without types
import { checkLock, nextTask, parsePlan, skippedTasks } from '../../build-mode/template/.claude/hooks/lib/plan.mjs'

type Task = { n: number; status: string; after: number[] }

const example = `# Plan

- [ ] 1. Tool registry derives a JSON schema from type hints
  verify: uv run pytest tests/test_registry.py -q
- [x] 2. Fake model replays a script file
  verify: uv run pytest tests/test_fake_model.py -q
  after: 1
  done: 3f2a9c1
- [!] 3. Trace saves as JSON
  verify: uv run pytest tests/test_trace.py -q
  after: 1, 2
  blocked: BLOCKED.md#task-3
`

function tasks(text: string): Task[] {
  const result = parsePlan(text)
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  return result.tasks
}

function errors(text: string): string[] {
  const result = parsePlan(text)
  assert.equal(result.ok, false)
  return result.errors.map((e: { line: number; message: string }) => `${e.line}: ${e.message}`)
}

function plan(...lines: string[]): string {
  return `# Plan\n\n${lines.join('\n')}\n`
}

test('parses the format example', () => {
  const parsed = tasks(example)
  assert.deepEqual(parsed.map(t => t.status), ['open', 'done', 'blocked'])
  assert.deepEqual(parsed.map(t => t.after), [[], [1], [1, 2]])
  assert.equal((parsed[1] as Task & { done: string }).done, '3f2a9c1')
  assert.equal((parsed[0] as Task & { verify: string }).verify, 'uv run pytest tests/test_registry.py -q')
})

test('reports a missing verify line by line number', () => {
  assert.deepEqual(errors('- [ ] 1. No check\n'), ['1: task 1 has no verify: line'])
})

test('reports duplicate task numbers', () => {
  assert.ok(errors(plan('- [ ] 1. A', '  verify: true', '- [ ] 1. B', '  verify: true')).some(e => e.includes('task 1 is numbered twice')))
})

test('reports an after: naming a task that does not exist', () => {
  assert.ok(errors(plan('- [ ] 1. A', '  verify: true', '  after: 9')).some(e => e.includes('task 1 depends on task 9, which does not exist')))
})

test('reports a dependency cycle', () => {
  const found = errors(plan('- [ ] 1. A', '  verify: true', '  after: 2', '- [ ] 2. B', '  verify: true', '  after: 1'))
  assert.ok(found.some(e => e.includes('dependency cycle') && e.includes('task 1')))
})

test('reports a done task without done: and a blocked task without blocked:', () => {
  const found = errors(plan('- [x] 1. A', '  verify: true', '- [!] 2. B', '  verify: true'))
  assert.ok(found.some(e => e.includes('task 1 is done but has no done: commit')))
  assert.ok(found.some(e => e.includes('task 2 is blocked but has no blocked: pointer')))
})

test('reports an unrecognised line inside the task list', () => {
  assert.ok(errors(plan('- [ ] 1. A', '  verify: true', '  owner: me')).some(e => e.startsWith('5: ')))
})

test('lock rejects a removed task', () => {
  const baseline = tasks(example)
  const current = baseline.filter(t => t.n !== 2)
  assert.deepEqual(checkLock(baseline, current), { ok: false, problems: ['task 2 was removed'] })
})

test('lock rejects a changed verify and a changed outcome', () => {
  const baseline = tasks(example)
  const current = tasks(example.replace('tests/test_registry.py -q', 'tests -q').replace('Trace saves as JSON', 'Trace exists'))
  const result = checkLock(baseline, current)
  assert.equal(result.ok, false)
  assert.ok(result.problems.includes('task 1 verify: changed'))
  assert.ok(result.problems.includes('task 3 outcome changed'))
})

test('lock rejects a dropped after entry and allows an added one', () => {
  const baseline = tasks(example)
  const dropped = tasks(example.replace('after: 1, 2', 'after: 1'))
  assert.deepEqual(checkLock(baseline, dropped), { ok: false, problems: ['task 3 after: lost 2'] })
  const added = tasks(example.replace('  verify: uv run pytest tests/test_fake_model.py -q\n  after: 1', '  verify: uv run pytest tests/test_fake_model.py -q\n  after: 1'))
  assert.deepEqual(checkLock(baseline, added), { ok: true })
  const gained = tasks(example).map(t => (t.n === 3 ? { ...t, after: [1, 2] } : t.n === 2 ? { ...t, after: [1] } : t))
  assert.deepEqual(checkLock(baseline, gained), { ok: true })
  const withLocked = [...baseline, { ...baseline[0], n: 4, after: [] }].map(t => (t.n === 4 ? t : t))
  assert.deepEqual(checkLock(withLocked, withLocked.map(t => (t.n === 4 ? { ...t, after: [1] } : t))), { ok: true })
})

test('lock rejects a new after: edge from a locked task to an appended task', () => {
  const baseline = tasks(example)
  const current = tasks(example + '- [!] 4. Dummy\n  verify: true\n  blocked: BLOCKED.md#task-4\n').map(t => (t.n === 3 ? { ...t, after: [1, 2, 4] } : t))
  assert.deepEqual(checkLock(baseline, current), { ok: false, problems: ['task 3 after: may not gain 4, which is not in the locked plan'] })
})

test('lock allows status changes and appended tasks', () => {
  const baseline = tasks(example)
  const current = tasks(
    example.replace('- [ ] 1.', '- [x] 1.').replace('verify: uv run pytest tests/test_registry.py -q', 'verify: uv run pytest tests/test_registry.py -q\n  done: abc1234') +
      '- [ ] 4. Appended\n  verify: true\n',
  )
  assert.deepEqual(checkLock(baseline, current), { ok: true })
})

test('nextTask skips tasks that depend transitively on a blocked task', () => {
  const parsed = tasks(
    plan(
      '- [!] 1. A', '  verify: true', '  blocked: BLOCKED.md#task-1',
      '- [ ] 2. B', '  verify: true', '  after: 1',
      '- [ ] 3. C', '  verify: true', '  after: 2',
      '- [ ] 4. D', '  verify: true',
    ),
  )
  assert.equal(nextTask(parsed)?.n, 4)
  assert.deepEqual(skippedTasks(parsed).map((t: Task) => t.n), [2, 3])
})

test('nextTask waits for open dependencies and returns null when nothing is runnable', () => {
  const parsed = tasks(plan('- [x] 1. A', '  verify: true', '  done: abc', '- [ ] 2. B', '  verify: true', '  after: 1', '- [ ] 3. C', '  verify: true', '  after: 2'))
  assert.equal(nextTask(parsed)?.n, 2)
  assert.equal(nextTask(tasks(plan('- [x] 1. A', '  verify: true', '  done: abc'))), null)
})
