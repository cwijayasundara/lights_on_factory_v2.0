import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { canStart, renderReport, runExperiment, summarize, worstCase, type Options, type Row } from '../../scripts/run-experiment.ts'

const factoryRoot = path.resolve(import.meta.dirname, '../..')
const tmp = (name: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)))

const row = (arm: 'a' | 'b' | 'c', run: number, accepted: boolean, costUsd: number | null): Row => ({
  arm, run, accepted, passed: accepted ? 4 : 2, tests: 4, costUsd, wallSeconds: 100, turns: 5, blocks: arm === 'a' ? 0 : 2, timedOut: false, sessionId: null,
})

test('the budget guard refuses a run whose worst case would pass the budget', () => {
  assert.equal(canStart(11.9, 4, 16), true)
  assert.equal(canStart(12.01, 4, 16), false)
})

test('worst case counts the writers and every build at the per-run cap', () => {
  assert.equal(worstCase({ arms: ['a', 'b', 'c'], runs: 1, perRunUsd: 4 }), 2 + 12)
  assert.equal(worstCase({ arms: ['a', 'b'], runs: 2, perRunUsd: 4 }), 1 + 16)
})

test('summaries give acceptance, mean cost and cost per accepted run per arm', () => {
  const rows = [row('a', 1, false, 1), row('a', 2, true, 3), row('b', 1, true, 2), row('c', 1, false, null)]
  const [a, b, c] = summarize(rows)
  assert.deepEqual([a.arm, a.runs, a.accepted, a.meanCostUsd, a.costPerAcceptedUsd], ['a', 2, 1, 2, 4])
  assert.deepEqual([b.accepted, b.costPerAcceptedUsd], [1, 2])
  assert.equal(c.meanCostUsd, null)
  assert.equal(c.costPerAcceptedUsd, null)
})

test('the report states the spend and does not claim significance', () => {
  const text = renderReport([row('a', 1, true, 1.5)], { spentUsd: 2.5, entries: [] }, { budgetUsd: 16, builderModel: 'claude-sonnet-5-5', effort: 'medium' })
  assert.match(text, /Spent \$2\.50 of \$16\.00/)
  assert.match(text, /\| a \| 1 \| 1\/1 \| \$1\.50 \| \$1\.50 \|/)
  assert.match(text, /not significance/)
})

// A fake claude: a writer session drops a suite, a builder session drops a file and reports its cost.
function fakeClaude(costUsd: number): { env: string; calls: string[][] } {
  const home = tmp('fake-claude-')
  const log = path.join(home, 'calls.jsonl')
  const bin = path.join(home, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh
node -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)) + "\\n")' "${log}" "$@"
case "$*" in
  *"You write the acceptance suite"*) mkdir -p acceptance && printf 'def test_x():\\n    assert 1\\n' > acceptance/test_x.py ;;
  *) echo built > built.txt; echo '{"total_cost_usd": ${costUsd}, "session_id": "sess-1", "num_turns": 7}' ;;
esac
`, { mode: 0o755 })
  const calls: string[][] = []
  return {
    env: bin,
    get calls() {
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : calls
    },
  }
}

function options(out: string, extra: Partial<Options> = {}): Options {
  const spec = path.join(tmp('spec-'), 'SPEC.md')
  fs.writeFileSync(spec, '# Spec\n')
  return {
    factoryRoot, spec, demo: 'echo demo', out, arms: ['a', 'b', 'c'], runs: 1, budgetUsd: 16, perRunUsd: 4,
    writerModel: 'claude-opus-5-5', builderModel: 'claude-sonnet-5-5', effort: 'medium', timeoutMinutes: 5,
    grader: () => ({ tests: 4, passed: 4, skipped: 0 }), ...extra,
  }
}

test('a pilot builds every arm in its own repository, records cost, and keeps the grading suite out of the builders', () => {
  const fake = fakeClaude(0.75)
  process.env.LIGHTS_ON_CLAUDE = fake.env
  try {
    const out = tmp('exp-')
    const { rows, ledger } = runExperiment(options(out))
    assert.deepEqual(rows.map(r => `${r.arm}${r.run}`), ['a1', 'b1', 'c1'])
    assert.ok(rows.every(r => r.accepted && r.costUsd === 0.75 && r.turns === 7 && r.sessionId === 'sess-1'))
    assert.equal(ledger.spentUsd, 2 + 3 * 0.75)
    const work = (name: string) => path.join(out, 'work', name)
    assert.ok(!fs.existsSync(path.join(work('a1'), '.factory')))
    assert.ok(fs.existsSync(path.join(work('b1'), '.factory/build.json')))
    assert.ok(!fs.existsSync(path.join(work('b1'), 'acceptance')))
    assert.ok(fs.existsSync(path.join(work('c1'), 'acceptance/test_x.py')))
    assert.equal(JSON.parse(fs.readFileSync(path.join(work('c1'), '.factory/build.json'), 'utf8')).acceptance.name, 'acceptance')
    for (const arm of ['a1', 'b1', 'c1']) assert.ok(!fs.existsSync(path.join(work(arm), 'grading')))
    const builds = fake.calls.filter(call => !call.join(' ').includes('You write the acceptance suite'))
    assert.equal(builds.length, 3)
    for (const call of builds) {
      const flags = call.join(' ')
      assert.match(flags, /--output-format json/)
      assert.match(flags, /--setting-sources project/)
      assert.match(flags, /--model claude-sonnet-5-5/)
      assert.match(flags, /--effort medium/)
      assert.match(flags, /--max-budget-usd 4/)
    }
    const writers = fake.calls.filter(call => call.join(' ').includes('You write the acceptance suite'))
    assert.equal(writers.length, 2)
    assert.ok(writers.every(call => call.join(' ').includes('--model claude-opus-5-5')))
    assert.match(fs.readFileSync(path.join(out, 'report.md'), 'utf8'), /\| c \| 1 \| 1\/1 \|/)
  } finally {
    delete process.env.LIGHTS_ON_CLAUDE
  }
})

test('the budget guard stops the experiment before an unaffordable run, and a rerun resumes without repeating work', () => {
  const fake = fakeClaude(3)
  process.env.LIGHTS_ON_CLAUDE = fake.env
  try {
    const out = tmp('exp-')
    const first = runExperiment(options(out, { arms: ['a', 'b'], budgetUsd: 7, perRunUsd: 4 }))
    assert.equal(first.rows.length, 1, 'writer 1 + build 3 = 4 spent; a second run could reach 8 > 7')
    const again = runExperiment(options(out, { arms: ['a', 'b'], budgetUsd: 20, perRunUsd: 4 }))
    assert.deepEqual(again.rows.map(r => `${r.arm}${r.run}`), ['a1', 'b1'])
    assert.equal(fake.calls.filter(call => call.join(' ').includes('You write the acceptance suite')).length, 1)
  } finally {
    delete process.env.LIGHTS_ON_CLAUDE
  }
})

test('a run that fails the hidden suite is recorded as not accepted', () => {
  const fake = fakeClaude(0.5)
  process.env.LIGHTS_ON_CLAUDE = fake.env
  try {
    const { rows } = runExperiment(options(tmp('exp-'), { arms: ['a'], grader: () => ({ tests: 4, passed: 3, skipped: 0 }) }))
    assert.equal(rows[0].accepted, false)
    assert.equal(rows[0].passed, 3)
  } finally {
    delete process.env.LIGHTS_ON_CLAUDE
  }
})

test('--dry-run prints the worst case and spawns nothing', () => {
  const fake = fakeClaude(1)
  const spec = path.join(tmp('spec-'), 'SPEC.md')
  fs.writeFileSync(spec, '# Spec\n')
  const result = spawnSync(process.execPath, [path.join(factoryRoot, 'scripts/run-experiment.ts'), '--spec', spec, '--demo', 'echo', '--out', tmp('exp-'), '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, LIGHTS_ON_CLAUDE: fake.env },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /worst case \$14\.00 against a budget of \$16\.00/)
  assert.equal(fake.calls.length, 0)
})
