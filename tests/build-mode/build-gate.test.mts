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

const planFor = (sha: string, verify = 'true') =>
  `# Plan\n\n- [x] 1. Build it\n  verify: ${verify}\n  done: ${sha}\n- [x] 2. Demo\n  verify: ${DEMO}\n  after: 1\n  done: ${sha}\n`
const head = (dir: string) => git(dir, 'rev-parse', '--short', 'HEAD')
let finished = planFor('0000000')
function finish(dir: string, verify = 'true'): void {
  finished = planFor(head(dir), verify)
}

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
  finish(dir)
  commitPlan(dir, finished)
  commitPlan(dir, finished.replace('verify: true', 'verify: echo skip'), 'weaken')
  assert.match(stop(dir).json?.reason ?? '', /^restore the plan: task 1 verify: changed/)
})

test('a gate that sleeps past timeoutSeconds fails as timed out', () => {
  const dir = repo([{ name: 'slow', run: 'sleep 5', timeoutSeconds: 1 }])
  finishedWithReport(dir)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate slow failed/)
  assert.match(reason, /timed out after 1s/)
})

test('a failing gate blocks with its output tail', () => {
  const dir = repo([{ name: 'tests', run: 'echo boom-line; exit 1', timeoutSeconds: 5 }])
  finishedWithReport(dir)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate tests failed/)
  assert.match(reason, /boom-line/)
})

test('a finished, committed build with a matching report may stop', () => {
  const dir = repo()
  finish(dir)
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
  finish(dir)
  commitPlan(dir, finished.replace('- [x] 2. Demo', '- [ ] 2. Demo').replace(/  done: \w+\n$/, ''))
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

test('a protected edit hidden with assume-unchanged still blocks', () => {
  const dir = repo()
  git(dir, 'update-index', '--assume-unchanged', '.factory/build.json')
  const config = JSON.parse(fs.readFileSync(path.join(dir, '.factory/build.json'), 'utf8'))
  fs.writeFileSync(path.join(dir, '.factory/build.json'), JSON.stringify({ ...config, gates: [] }, null, 2))
  assert.equal(git(dir, 'status', '--porcelain'), '')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files[\s\S]*\.factory\/build\.json/)
})

test('a new file under a protected directory blocks', () => {
  const dir = repo()
  fs.mkdirSync(path.join(dir, '.claude/hooks'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.claude/hooks/extra.mjs'), '')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files[\s\S]*\.claude\/hooks\/extra\.mjs/)
})

function finishedWithReport(dir: string, verify = 'true'): void {
  finish(dir, verify)
  commitPlan(dir, finished)
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'COMPLETE\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'docs: report')
}

test('a done task whose verify fails blocks', () => {
  const dir = repo()
  finishedWithReport(dir, 'exit 1')
  assert.equal(stop(dir).json?.reason, 'task 1 is marked done but its verify: fails; reopen it or fix it')
})

test('a done: that is not a commit on this branch blocks', () => {
  const dir = repo()
  finish(dir)
  commitPlan(dir, finished.replaceAll(head(dir), 'abc1234'))
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'COMPLETE\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'docs: report')
  assert.equal(stop(dir).json?.reason, 'task 1 is marked done but done: abc1234 is not a commit on this branch; reopen it or fix it')
})

test('a remote without an upstream branch blocks until pushed', () => {
  const dir = repo()
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-'))
  git(origin, 'init', '-q', '--bare')
  git(dir, 'remote', 'add', 'origin', origin)
  finishedWithReport(dir)
  assert.match(stop(dir).json?.reason ?? '', /no upstream branch; push with: git push -u origin main/)
  git(dir, 'push', '-q', '-u', 'origin', 'main')
  assert.equal(stop(dir).out, '')
})

test('python bytecode caches under a protected directory are ignored', () => {
  const dir = repo()
  fs.mkdirSync(path.join(dir, '.factory/gates/__pycache__'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.factory/gates/__pycache__/_gate.cpython-314.pyc'), 'x')
  assert.equal(stop(dir).json?.reason, 'write PLAN.md from SPEC.md')
})
