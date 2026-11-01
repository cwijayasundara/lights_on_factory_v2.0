import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error plain ESM hook module without types
import { decide } from '../../build-mode/template/.claude/hooks/lib/decide.mjs'
// @ts-expect-error plain ESM hook module without types
import { parsePlan } from '../../build-mode/template/.claude/hooks/lib/plan.mjs'

const DEMO = 'uv run mini-agent demo'
const limits = { maxBlockedTasks: 2, maxNoProgressBlocks: 8, wallClockHours: 6, maxAcceptedMutants: 5 }

type Gate = { name: string; ok: boolean; tail: string }

function planText(...tasks: string[]): string {
  return `# Plan\n\n${tasks.join('\n')}\n`
}

const done = (n: number, verify = 'true', after = '') =>
  `- [x] ${n}. Task ${n}\n  verify: ${verify}${after ? `\n  after: ${after}` : ''}\n  done: abc${n}`
const open = (n: number, verify = 'true', after = '') => `- [ ] ${n}. Task ${n}\n  verify: ${verify}${after ? `\n  after: ${after}` : ''}`
const blocked = (n: number, verify = 'true', after = '') =>
  `- [!] ${n}. Task ${n}\n  verify: ${verify}${after ? `\n  after: ${after}` : ''}\n  blocked: BLOCKED.md#task-${n}`

const allDone = planText(done(1), done(2, DEMO, '1'))

function ctx(overrides: Record<string, unknown> = {}) {
  const text = (overrides.planText as string | undefined) ?? allDone
  const gates: Gate[] = (overrides.gates as Gate[] | undefined) ?? [
    { name: 'tests', ok: true, tail: '' },
    { name: 'demo', ok: true, tail: '' },
  ]
  const calls: { skipDemo: boolean }[] = []
  const base = {
    protectedDiff: '',
    plan: text === '' ? null : parsePlan(text),
    lock: { ok: true },
    demoRun: DEMO,
    runGates: (options: { skipDemo: boolean }) => {
      calls.push(options)
      return options.skipDemo ? gates.filter(g => g.name !== 'demo') : gates
    },
    uncommitted: '',
    checkDone: () => null,
    report: { exists: true, fresh: true, header: 'COMPLETE' },
    acceptedMutants: 0,
    limits,
    guard: { noProgressBlocks: 0, elapsedHours: 0 },
  }
  const { planText: _ignored, gates: _g, ...rest } = overrides
  return { context: { ...base, ...rest }, calls }
}

function reason(overrides: Record<string, unknown> = {}): string {
  const result = decide(ctx(overrides).context)
  assert.equal(result.kind, 'block', JSON.stringify(result))
  return result.reason
}

test('blocks on a protected diff', () => {
  assert.match(reason({ protectedDiff: ' M SPEC.md' }), /^restore the protected files/)
})

test('blocks on a missing plan', () => {
  assert.equal(reason({ planText: '' }), 'write PLAN.md from SPEC.md')
})

test('blocks on a parse error naming the line', () => {
  assert.match(reason({ planText: '- [ ] 1. No check\n' }), /^fix PLAN.md: line 1: task 1 has no verify: line/)
})

test('blocks on a lock violation', () => {
  assert.match(reason({ lock: { ok: false, problems: ['task 2 was removed'] } }), /^restore the plan: task 2 was removed/)
})

test("blocks when the last task's verify is not the demo command", () => {
  assert.equal(reason({ planText: planText(done(1), done(2)) }), `the last task must verify with: ${DEMO}`)
})

test('blocks on the next open task', () => {
  assert.match(reason({ planText: planText(done(1), done(2), done(3), open(4, 'true', '3'), open(5, DEMO, '4')) }), /^next task: 4\. Task 4/)
})

test('runs gates only after task checks pass', () => {
  const { context, calls } = ctx({ planText: planText(open(1), open(2, DEMO, '1')) })
  assert.equal(decide(context).kind, 'block')
  assert.equal(calls.length, 0)
})

test('blocks on a failed gate with its name and tail', () => {
  const text = reason({ gates: [{ name: 'tests', ok: true, tail: '' }, { name: 'crap', ok: false, tail: 'grade 33.7' }] })
  assert.match(text, /^gate crap failed/)
  assert.match(text, /grade 33\.7/)
})

test('PARTIAL leaves out the demo gate only when the demo task is blocked or skipped', () => {
  const skippedDemo = ctx({
    planText: planText(blocked(1), open(2, DEMO, '1')),
    report: { exists: true, fresh: true, header: 'PARTIAL' },
  })
  assert.deepEqual(decide(skippedDemo.context), { kind: 'allow', header: 'PARTIAL' })
  assert.deepEqual(skippedDemo.calls, [{ skipDemo: true }])

  const demoDone = ctx({
    planText: planText(blocked(1), done(2), done(3, DEMO, '2')),
    report: { exists: true, fresh: true, header: 'PARTIAL' },
  })
  assert.deepEqual(decide(demoDone.context), { kind: 'allow', header: 'PARTIAL' })
  assert.deepEqual(demoDone.calls, [{ skipDemo: false }])
})

test('checks commit state and the report before running gates', () => {
  const dirty = ctx({ uncommitted: ' M src/app.py' })
  assert.match(decide(dirty.context).reason, /^commit and push your work/)
  assert.equal(dirty.calls.length, 0)
  const noReport = ctx({ report: { exists: false, fresh: false, header: null } })
  assert.match(decide(noReport.context).reason, /^write BUILD-REPORT.md/)
  assert.equal(noReport.calls.length, 0)
})

test('blocks when a done task does not hold, before running gates', () => {
  const { context, calls } = ctx({ checkDone: () => 'task 1 is marked done but its verify: fails' })
  assert.equal(decide(context).reason, 'task 1 is marked done but its verify: fails; reopen it or fix it')
  assert.equal(calls.length, 0)
})

test('blocks on uncommitted work before checking the report', () => {
  assert.match(reason({ uncommitted: ' M src/app.py' }), /^commit and push your work/)
})

test('requires the report header to match', () => {
  assert.equal(
    reason({ acceptedMutants: 2, report: { exists: true, fresh: true, header: 'COMPLETE' } }),
    'write BUILD-REPORT.md with first line "COMPLETE (2 accepted mutants)"',
  )
  assert.equal(reason({ report: { exists: false, fresh: false, header: null } }), 'write BUILD-REPORT.md with first line "COMPLETE"')
  assert.equal(reason({ report: { exists: true, fresh: false, header: 'COMPLETE' } }), 'write BUILD-REPORT.md with first line "COMPLETE"')
})

test('allows COMPLETE when everything passes', () => {
  assert.deepEqual(decide(ctx().context), { kind: 'allow', header: 'COMPLETE' })
})

test('stalls on no progress, on wall clock, and on a third blocked task', () => {
  const stalled = (overrides: Record<string, unknown>) => {
    const result = decide(ctx(overrides).context)
    assert.equal(result.kind, 'allow')
    assert.equal(result.header, 'STALLED')
    return result.reason as string
  }
  assert.match(stalled({ guard: { noProgressBlocks: 8, elapsedHours: 1 } }), /no progress/)
  assert.match(stalled({ guard: { noProgressBlocks: 0, elapsedHours: 6 } }), /wall clock/)
  assert.match(stalled({ planText: planText(blocked(1), blocked(2), blocked(3), open(4, DEMO)) }), /3 tasks blocked/)
})
