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

// ---- lifecycle: build -> maintain ----

const FLIP = 'chore: build complete, enter maintain'
const level = (gates: Gate[], levels: string[]) => gates.map((gate, i) => ({ ...gate, level: levels[i] }))

function completedBuild(gates: Gate[] = [{ name: 'tests', run: 'true', timeoutSeconds: 5 }]): string {
  const dir = repo(level(gates, gates.map(() => 'fast')) as Gate[])
  finishedWithReport(dir)
  return dir
}

function readLog(dir: string) {
  return fs.readFileSync(path.join(dir, '.factory/hook-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

test('allowing COMPLETE flips the repository to maintain in its own commit', () => {
  const dir = completedBuild()
  assert.equal(stop(dir).out, '')
  assert.equal(fs.readFileSync(path.join(dir, '.factory/phase'), 'utf8').trim(), 'maintain')
  assert.equal(git(dir, 'log', '-1', '--format=%s'), FLIP)
  assert.equal(git(dir, 'status', '--porcelain'), '')
})

test('a post-COMPLETE session is not stalled by an old clock or a stale fingerprint', () => {
  const dir = completedBuild()
  assert.equal(stop(dir).out, '')
  fs.writeFileSync(path.join(dir, '.factory/build-state.json'), JSON.stringify({ startedAt: new Date(Date.now() - 9 * 3600_000).toISOString(), noProgressBlocks: 20 }))
  for (let i = 0; i < 4; i += 1) assert.equal(stop(dir).out, '')
  assert.equal(fs.readFileSync(path.join(dir, 'BUILD-REPORT.md'), 'utf8'), 'COMPLETE\n')
  assert.ok(readLog(dir).every(entry => entry.header !== 'STALLED'))
})

test('maintain blocks on a failing fast gate and ignores full gates, the plan and the report', () => {
  const dir = repo(level([{ name: 'tests', run: 'echo red-line; exit 1', timeoutSeconds: 5 }, { name: 'mutate', run: 'exit 1', timeoutSeconds: 5 }], ['fast', 'full']) as Gate[])
  fs.writeFileSync(path.join(dir, '.factory/phase'), 'maintain\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', FLIP)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate tests failed/)
  assert.match(reason, /red-line/)
  const green = repo(level([{ name: 'tests', run: 'true', timeoutSeconds: 5 }, { name: 'mutate', run: 'exit 1', timeoutSeconds: 5 }], ['fast', 'full']) as Gate[])
  fs.writeFileSync(path.join(green, '.factory/phase'), 'maintain\n')
  git(green, 'add', '-A')
  git(green, 'commit', '-q', '-m', FLIP)
  assert.equal(stop(green).out, '')
  assert.equal(fs.existsSync(path.join(green, 'BUILD-REPORT.md')), false)
})

test('maintain still rejects edits to protected files', () => {
  const dir = completedBuild()
  stop(dir)
  fs.appendFileSync(path.join(dir, 'SPEC.md'), 'easier now\n')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files/)
})

test('a phase file with no flip commit does not escape the build gates', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, '.factory/phase'), 'maintain\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'sneaky')
  assert.equal(stop(dir).json?.reason, 'write PLAN.md from SPEC.md')
})

test('STALLED is not stacked, and never overwrites a COMPLETE report', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'draft\n')
  for (let round = 0; round < 3; round += 1) {
    fs.writeFileSync(path.join(dir, '.factory/build-state.json'), JSON.stringify({ startedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }))
    stop(dir)
  }
  const report = fs.readFileSync(path.join(dir, 'BUILD-REPORT.md'), 'utf8')
  assert.equal(report.split('STALLED').length - 1, 1)
  assert.match(report, /\n\ndraft\n$/)
  fs.writeFileSync(path.join(dir, 'BUILD-REPORT.md'), 'COMPLETE\n\nAll good.\n')
  fs.writeFileSync(path.join(dir, '.factory/build-state.json'), JSON.stringify({ startedAt: new Date(Date.now() - 7 * 3600_000).toISOString() }))
  stop(dir)
  assert.equal(fs.readFileSync(path.join(dir, 'BUILD-REPORT.md'), 'utf8'), 'COMPLETE\n\nAll good.\n')
})

test('session-start tells a maintain session that questions are allowed', () => {
  const dir = completedBuild()
  stop(dir)
  const out = spawnSync(process.execPath, [hook, 'session-start'], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8' })
  const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string
  assert.match(context, /^Maintain mode/)
  assert.doesNotMatch(context, /PLAN\.md/)
})

// ---- behaviour layer, part 1: acceptance suite and the no-weakening guard ----

function repoWithFiles(files: Record<string, string>, extra: Record<string, unknown> = {}): string {
  const dir = repo([{ name: 'tests', run: 'true', timeoutSeconds: 5 }], { testPaths: ['tests/'], ...extra })
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '--amend', '--no-edit')
  return dir
}

const OLD_TEST = 'def test_add():\n    assert add(1, 2) == 3\n    assert add(0, 0) == 0\n'
const WEAKENED = /^restore the assertions removed or loosened in existing tests/

test('removing an assertion from a test that existed at install blocks', () => {
  const dir = repoWithFiles({ 'tests/test_add.py': OLD_TEST })
  fs.writeFileSync(path.join(dir, 'tests/test_add.py'), 'def test_add():\n    assert add(1, 2) == 3\n')
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, WEAKENED)
  assert.match(reason, /tests\/test_add\.py: assert add\(0, 0\) == 0/)
})

test('loosening, deleting or committing the weakening still blocks', () => {
  const dir = repoWithFiles({ 'tests/test_add.py': OLD_TEST })
  fs.writeFileSync(path.join(dir, 'tests/test_add.py'), 'def test_add():\n    assert add(1, 2)\n    assert add(0, 0) == 0\n')
  git(dir, 'commit', '-qam', 'make it pass')
  assert.match(stop(dir).json?.reason ?? '', WEAKENED)
  fs.rmSync(path.join(dir, 'tests/test_add.py'))
  assert.match(stop(dir).json?.reason ?? '', /deleted: tests\/test_add\.py/)
})

test('new tests and extra assertions beside the old ones are allowed', () => {
  const dir = repoWithFiles({ 'tests/test_add.py': OLD_TEST })
  fs.appendFileSync(path.join(dir, 'tests/test_add.py'), '    assert add(2, 2) == 4\n')
  fs.writeFileSync(path.join(dir, 'tests/test_new.py'), 'def test_new():\n    assert True\n')
  assert.equal(stop(dir).json?.reason, 'write PLAN.md from SPEC.md')
})

test('files outside testPaths are not policed', () => {
  const dir = repoWithFiles({ 'src/check.py': 'assert VALUE == 1\n' })
  fs.writeFileSync(path.join(dir, 'src/check.py'), 'VALUE = 2\n')
  assert.equal(stop(dir).json?.reason, 'write PLAN.md from SPEC.md')
})

test('an acceptance file cannot be edited or added when acceptance/ is protected', () => {
  const protectedList = ['.claude/', '.factory/build.json', '.factory/gates/', 'SPEC.md', 'acceptance/']
  const dir = repoWithFiles({ 'acceptance/test_demo.py': 'def test_demo():\n    assert 1\n' }, { protected: protectedList })
  fs.appendFileSync(path.join(dir, 'acceptance/test_demo.py'), '    pass\n')
  assert.match(stop(dir).json?.reason ?? '', /^restore the protected files[\s\S]*changed: acceptance\/test_demo\.py/)
  git(dir, 'checkout', '--', 'acceptance')
  fs.writeFileSync(path.join(dir, 'acceptance/test_extra.py'), '')
  assert.match(stop(dir).json?.reason ?? '', /added: acceptance\/test_extra\.py/)
})

test('the acceptance suite runs at Stop and a failure blocks with its output', () => {
  const dir = repoWithFiles({}, { acceptance: { name: 'acceptance', run: 'echo spec-says-no; exit 1', timeoutSeconds: 5 } })
  finishedWithReport(dir)
  const reason = stop(dir).json?.reason ?? ''
  assert.match(reason, /^gate acceptance failed/)
  assert.match(reason, /spec-says-no/)
})

test('a passing acceptance suite lets the build finish', () => {
  const dir = repoWithFiles({}, { acceptance: { name: 'acceptance', run: 'true', timeoutSeconds: 5 } })
  finishedWithReport(dir)
  assert.equal(stop(dir).out, '')
})

test('maintain runs the acceptance suite too', () => {
  const dir = repoWithFiles({}, { acceptance: { name: 'acceptance', run: 'exit 1', timeoutSeconds: 5 } })
  fs.writeFileSync(path.join(dir, '.factory/phase'), 'maintain\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', FLIP)
  assert.match(stop(dir).json?.reason ?? '', /^gate acceptance failed/)
})
