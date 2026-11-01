import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const hook = path.resolve(import.meta.dirname, '../../build-mode/template/.claude/hooks/build-gate.mjs')
const DEMO = 'echo demo'

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

type Gate = { name: string; run: string; timeoutSeconds: number }

function buildJson(gates: Gate[], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    spec: 'SPEC.md',
    plan: 'PLAN.md',
    sources: ['src'],
    protected: ['.claude/', '.factory/build.json', '.factory/gates/', 'SPEC.md'],
    gates,
    demo: { name: 'demo', run: DEMO, timeoutSeconds: 5 },
    acceptedMutants: '.factory/accepted-mutants.md',
    limits: { maxBlockedTasks: 2, maxNoProgressBlocks: 8, wallClockHours: 6, maxAcceptedMutants: 5 },
    tools: {},
    ...extra,
  }
}

function repo(gates: Gate[] = [{ name: 'tests', run: 'true', timeoutSeconds: 5 }], extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-gate-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'SPEC.md'), '# Spec\n')
  fs.mkdirSync(path.join(dir, '.factory'))
  fs.writeFileSync(path.join(dir, '.factory/build.json'), JSON.stringify(buildJson(gates, extra), null, 2))
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/build-state.json\n.factory/hook-log.jsonl\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: install build mode')
  return dir
}

function commitPlan(dir: string, text: string, message = 'docs: plan'): void {
  fs.writeFileSync(path.join(dir, 'PLAN.md'), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

const finished = `# Plan\n\n- [x] 1. Build it\n  verify: true\n  done: abc\n- [x] 2. Demo\n  verify: ${DEMO}\n  after: 1\n  done: def\n`

function stop(dir: string, input: unknown = { cwd: dir }) {
  const result = spawnSync(process.execPath, [hook, 'stop'], { input: JSON.stringify(input), encoding: 'utf8' })
  const out = result.stdout.trim()
  return { status: result.status, out, json: out ? (JSON.parse(out) as { decision?: string; reason?: string }) : null }
}

test('no git repository blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-gate-nogit-'))
  const result = stop(dir)
  assert.equal(result.status, 0)
  assert.equal(result.json?.decision, 'block')
  assert.equal(result.json?.reason, 'target is not a git repository with an install commit')
})

test('a repository without an install commit blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-gate-empty-'))
  git(dir, 'init', '-q')
  assert.equal(stop(dir).json?.reason, 'target is not a git repository with an install commit')
})

test('a missing plan blocks', () => {
  assert.equal(stop(repo()).json?.reason, 'write PLAN.md from SPEC.md')
})

test('an edited SPEC.md blocks, committed or not', () => {
  const dir = repo()
  fs.appendFileSync(path.join(dir, 'SPEC.md'), 'easier now\n')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files/)
  git(dir, 'commit', '-qam', 'cheat')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files/)
})

test('a plan edited against its committed baseline blocks', () => {
  const dir = repo()
  commitPlan(dir, finished)
  commitPlan(dir, finished.replace('verify: true', 'verify: echo skip'), 'weaken')
  assert.match(stop(dir).json?.reason ?? '', /^restore the plan: task 1 verify: changed/)
})

test('a gate that sleeps past timeoutSeconds fails as timed out', () => {
  const dir = repo([{ name: 'slow', run: 'sleep 5', timeoutSeconds: 1 }])
  commitPlan(dir, finished)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate slow failed/)
  assert.match(reason, /timed out after 1s/)
})

test('a failing gate blocks with its output tail', () => {
  const dir = repo([{ name: 'tests', run: 'echo boom-line; exit 1', timeoutSeconds: 5 }])
  commitPlan(dir, finished)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate tests failed/)
  assert.match(reason, /boom-line/)
})

test('a finished, committed build with a matching report may stop', () => {
  const dir = repo()
  commitPlan(dir, finished)
  assert.match(stop(dir).json?.reason ?? '', /^write BUILD-REPORT.md with first line "COMPLETE"/)
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'COMPLETE\n\nAll good.\n')
  assert.match(stop(dir).json?.reason ?? '', /^commit and push your work/)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'docs: report')
  const result = stop(dir)
  assert.equal(result.status, 0)
  assert.equal(result.out, '')
  const log = fs.readFileSync(path.join(dir, '.factory/hook-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(log.at(-1).decision, 'allow')
  assert.equal(log.at(-1).header, 'COMPLETE')
})

test('invalid build.json blocks with build-gate error and exits 0', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, '.factory/build.json'), '{ not json')
  const result = stop(dir)
  assert.equal(result.status, 0)
  assert.match(result.json?.reason ?? '', /^build-gate error: /)
})

test('eight unchanged blocks then allows STALLED and prepends it to BUILD-REPORT.md', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'draft\n')
  for (let i = 0; i < 8; i += 1) assert.equal(stop(dir).json?.decision, 'block', `call ${i + 1}`)
  const result = stop(dir)
  assert.equal(result.out, '')
  const report = fs.readFileSync(path.join(dir, 'BUILD-REPORT.md'), 'utf8')
  assert.match(report, /^STALLED\n\nStopped by the build-mode loop guard: no progress in 8 consecutive blocks\.\n\ndraft\n$/)
})

test('progress resets the no-progress count', () => {
  const dir = repo()
  for (let i = 0; i < 7; i += 1) stop(dir)
  commitPlan(dir, finished.replace('- [x] 2. Demo', '- [ ] 2. Demo').replace('  done: def\n', ''))
  for (let i = 0; i < 7; i += 1) assert.equal(stop(dir).json?.decision, 'block')
})

test('session-start prints the additionalContext line and sets startedAt once', () => {
  const dir = repo()
  const run = () => spawnSync(process.execPath, [hook, 'session-start'], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8' })
  const first = run()
  assert.equal(first.status, 0)
  assert.deepEqual(JSON.parse(first.stdout), {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Build mode: invoke the build-discipline skill now, then continue PLAN.md from its next open task.',
    },
  })
  const startedAt = JSON.parse(fs.readFileSync(path.join(dir, '.factory/build-state.json'), 'utf8')).startedAt
  assert.ok(startedAt)
  run()
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.factory/build-state.json'), 'utf8')).startedAt, startedAt)
})

test('the wall clock budget stalls the run', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, '.factory/build-state.json'), JSON.stringify({ startedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }))
  const result = stop(dir)
  assert.equal(result.out, '')
  assert.match(fs.readFileSync(path.join(dir, 'BUILD-REPORT.md'), 'utf8'), /^STALLED\n\nStopped by the build-mode loop guard: wall clock budget of 6 hours used\./)
})
