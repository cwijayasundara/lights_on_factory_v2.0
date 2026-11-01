#!/usr/bin/env node
// Build-mode hook. `stop`: decide whether the session may end. `session-start`: start the clock, point at the skill.
// Always exits 0: a Stop hook that crashes would let the session stop silently, so errors become blocks.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { decide, decideMaintain } from './lib/decide.mjs'
import { checkLock, parsePlan } from './lib/plan.mjs'
import { fromTranscript, recordEvent } from './lib/runs.mjs'
import { removedAssertions } from './lib/weakening.mjs'

const INSTALL_SUBJECT = 'chore: install build mode'
const NOT_A_TARGET = 'target is not a git repository with an install commit'
const REPORT = 'BUILD-REPORT.md'
const NOT_CODE = [REPORT, 'DECISIONS.md', 'BLOCKED.md', 'PLAN.md']
const PHASE = '.factory/phase'
const FLIP_SUBJECT = 'chore: build complete, enter maintain'
const STATE = '.factory/build-state.json'
const LOG = '.factory/hook-log.jsonl'
const DEFAULT_NO_PROGRESS = 8
const VERIFY_TIMEOUT_SECONDS = 600

const BUILD_CONTEXT = 'Build mode: invoke the build-discipline skill now, then continue PLAN.md from its next open task.'
const MAINTAIN_CONTEXT =
  'Maintain mode: the build is complete and the operator is at the keyboard. Questions are allowed. Make focused changes, one commit each. The Stop hook runs the fast gates only; do not write BUILD-REPORT.md.'

class NotATarget extends Error {}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  })
  return result.status === 0 ? result.stdout.trim() : null
}

function findRoot(cwd) {
  const root = fs.existsSync(cwd) ? git(cwd, ['rev-parse', '--show-toplevel']) : null
  if (!root) throw new NotATarget(NOT_A_TARGET)
  // The latest install (or reinstall) commit is the baseline for the protected files.
  const install = (git(root, ['log', '-1', '--format=%H', `--grep=^${INSTALL_SUBJECT}$`, '--', '.factory/build.json']) ?? '').trim()
  if (!install) throw new NotATarget(NOT_A_TARGET)
  return { root, install }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function tail(text, lines = 40) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

// Compare protected files by content against the install commit, so index tricks
// (assume-unchanged, skip-worktree, clean filters) cannot hide an edit.
function protectedDiff(root, install, paths) {
  const committed = new Map()
  const listing = git(root, ['ls-tree', '-r', install, '--', ...paths]) ?? ''
  for (const line of listing.split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t')
    committed.set(file, meta.split(' ')[2])
  }
  const present = new Set(paths.flatMap(entry => walk(root, entry.replace(/\/$/, ''))))
  const problems = []
  for (const [file, blob] of committed) {
    if (!present.has(file)) problems.push(`deleted: ${file}`)
    else if (git(root, ['hash-object', '--no-filters', file]) !== blob) problems.push(`changed: ${file}`)
  }
  for (const file of present) if (!committed.has(file)) problems.push(`added: ${file}`)
  return problems.sort().join('\n')
}

function walk(root, relative) {
  const full = path.join(root, relative)
  if (!fs.existsSync(full)) return []
  if (!fs.statSync(full).isDirectory()) return [relative]
  return fs
    .readdirSync(full)
    .filter(name => name !== '__pycache__')
    .flatMap(name => walk(root, path.posix.join(relative, name)))
}

// Existing tests (those at the install commit) may gain assertions and files, never lose or loosen them.
function weakenedTests(root, install, testPaths = []) {
  if (testPaths.length === 0) return ''
  const files = (git(root, ['ls-tree', '-r', '--name-only', install, '--', ...testPaths]) ?? '').split('\n').filter(Boolean)
  const problems = []
  for (const file of files) {
    const full = path.join(root, file)
    if (!fs.existsSync(full)) {
      problems.push(`deleted: ${file}`)
      continue
    }
    const lost = removedAssertions(git(root, ['show', `${install}:${file}`]) ?? '', fs.readFileSync(full, 'utf8'))
    for (const line of lost) problems.push(`${file}: ${line}`)
  }
  return problems.join('\n')
}

function checkDone(root, tasks) {
  for (const task of tasks.filter(t => t.status === 'done')) {
    const sha = git(root, ['rev-parse', '--verify', '--quiet', `${task.done}^{commit}`])
    if (!sha || git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']) === null) {
      return `task ${task.n} is marked done but done: ${task.done} is not a commit on this branch`
    }
    const result = runGate(root, { name: `task ${task.n}`, run: task.verify, timeoutSeconds: VERIFY_TIMEOUT_SECONDS })
    if (!result.ok) return `task ${task.n} is marked done but its verify: fails`
  }
  return null
}

// The lock baseline is the earliest committed PLAN.md that parses.
function lockFor(root, planFile, plan) {
  if (!plan?.ok) return { ok: true }
  const commits = (git(root, ['log', '--reverse', '--format=%H', '--', planFile]) ?? '').split('\n').filter(Boolean)
  for (const sha of commits) {
    const baseline = parsePlan(git(root, ['show', `${sha}:${planFile}`]) ?? '')
    if (baseline.ok) return checkLock(baseline.tasks, plan.tasks)
  }
  return { ok: true }
}

// What this invocation ran, for the run record. One hook invocation is one process, so module state is safe.
const observed = { gates: [], plan: null, session: {} }

function runGate(root, gate) {
  const began = Date.now()
  const result = runGateUntimed(root, gate)
  return { ...result, seconds: (Date.now() - began) / 1000 }
}

function runGateUntimed(root, gate) {
  const result = spawnSync(gate.run, { cwd: root, shell: true, encoding: 'utf8', timeout: gate.timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 })
  if (result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal)) {
    return { name: gate.name, ok: false, tail: `${tail(result.stdout ?? '', 20)}\ntimed out after ${gate.timeoutSeconds}s` }
  }
  return { name: gate.name, ok: result.status === 0, tail: tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) }
}

function runGates(root, config, { skipDemo }) {
  const gates = [...config.gates, ...(config.acceptance ? [config.acceptance] : []), ...(skipDemo ? [] : [config.demo])]
  const results = []
  for (const gate of gates) {
    const result = runGate(root, gate)
    observed.gates.push(result)
    results.push(result)
    if (!result.ok) break
  }
  return results
}

function uncommitted(root) {
  const status = git(root, ['status', '--porcelain']) ?? ''
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '@{u}'])
  const remote = (git(root, ['remote']) ?? '').split('\n').filter(Boolean)[0]
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  let push = ''
  if (upstream) {
    const ahead = Number(git(root, ['rev-list', '--count', '@{u}..HEAD']) ?? '0')
    if (ahead > 0) push = `${ahead} commit(s) not pushed to ${upstream}`
  } else if (remote) {
    push = `no upstream branch; push with: git push -u ${remote} ${branch}`
  }
  return [status, push].filter(Boolean).join('\n')
}

function reportState(root) {
  const file = path.join(root, REPORT)
  if (!fs.existsSync(file)) return { exists: false, fresh: false, header: null }
  const header = fs.readFileSync(file, 'utf8').split('\n')[0].trim()
  const excludes = NOT_CODE.map(name => `:(exclude)${name}`)
  const lastCode = Number(git(root, ['log', '-1', '--format=%ct', '--', '.', ...excludes]) ?? '0')
  const fresh = Math.floor(fs.statSync(file).mtimeMs / 1000) >= lastCode
  return { exists: true, fresh, header }
}

function countAccepted(root, config) {
  const file = path.join(root, config.acceptedMutants)
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter(line => /^- \S+:\d+ /.test(line)).length
}

function fingerprint(root, plan) {
  const head = git(root, ['rev-parse', 'HEAD']) ?? 'none'
  const statuses = plan?.ok ? plan.tasks.map(task => `${task.n}${task.status[0]}`).join(' ') : 'noplan'
  return `${head} ${statuses}`
}

// `maintain` counts only if the hook's own flip commit touched the phase file, so editing
// the file alone cannot switch the build gates off.
function readPhase(root) {
  const text = fs.existsSync(path.join(root, PHASE)) ? fs.readFileSync(path.join(root, PHASE), 'utf8').trim() : 'build'
  if (text !== 'maintain') return 'build'
  return git(root, ['log', '-1', '--format=%H', `--grep=^${FLIP_SUBJECT}$`, '--', PHASE]) ? 'maintain' : 'build'
}

function flipToMaintain(root) {
  fs.writeFileSync(path.join(root, PHASE), 'maintain\n')
  const committed = git(root, ['add', '--', PHASE]) !== null && git(root, ['commit', '-q', '-m', FLIP_SUBJECT, '--', PHASE]) !== null
  if (!committed) {
    git(root, ['reset', '-q', '--', PHASE])
    fs.rmSync(path.join(root, PHASE), { force: true })
    log(root, { decision: 'note', reason: 'could not commit the flip to maintain' })
  }
}

const STAMP = /^(STALLED\n\nStopped by the build-mode loop guard: .*\n\n)+/

function stamp(root, reason) {
  const file = path.join(root, REPORT)
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  // A finished report is the record of the build; a later stall must not bury it.
  if (current.startsWith('COMPLETE')) return
  const existing = current.replace(STAMP, '')
  fs.writeFileSync(file, `STALLED\n\nStopped by the build-mode loop guard: ${reason}.\n\n${existing}`)
}

function log(root, entry) {
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true })
  fs.appendFileSync(path.join(root, LOG), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

function saveState(root, state) {
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true })
  fs.writeFileSync(path.join(root, STATE), `${JSON.stringify(state, null, 2)}\n`)
}

function stop(root, install) {
  const phase = readPhase(root)
  const state = readJson(path.join(root, STATE), {})
  state.startedAt ??= new Date().toISOString()
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, '.factory/build.json'), 'utf8'))
    const planFile = path.join(root, config.plan)
    const plan = fs.existsSync(planFile) ? parsePlan(fs.readFileSync(planFile, 'utf8')) : null
    observed.plan = plan
    const print = fingerprint(root, plan)
    const noProgressBlocks = print === state.lastFingerprint ? (state.noProgressBlocks ?? 0) : 0
    if (phase === 'maintain') {
      const gates = [...config.gates.filter(gate => gate.level === 'fast'), ...(config.acceptance ? [config.acceptance] : [])]
      const decision = decideMaintain({
        protectedDiff: protectedDiff(root, install, config.protected),
        runGates: () => {
          const results = []
          for (const gate of gates) {
            results.push(runGate(root, gate))
            observed.gates.push(results.at(-1))
            if (!results.at(-1).ok) break
          }
          return results
        },
      })
      return finish(root, state, decision, 'maintain', 0, phase)
    }
    const decision = decide({
      protectedDiff: protectedDiff(root, install, config.protected),
      weakened: weakenedTests(root, install, config.testPaths),
      plan,
      lock: lockFor(root, config.plan, plan),
      demoRun: config.demo.run,
      runGates: options => runGates(root, config, options),
      uncommitted: uncommitted(root),
      checkDone: () => checkDone(root, plan.tasks),
      report: reportState(root),
      acceptedMutants: countAccepted(root, config),
      limits: config.limits,
      guard: { noProgressBlocks, elapsedHours: (Date.now() - Date.parse(state.startedAt)) / 3600_000 },
    })
    return finish(root, state, decision, print, noProgressBlocks, phase)
  } catch (error) {
    const noProgressBlocks = state.lastFingerprint === 'error' ? (state.noProgressBlocks ?? 0) : 0
    const limit = readJson(path.join(root, '.factory/build.json'), {})?.limits?.maxNoProgressBlocks ?? DEFAULT_NO_PROGRESS
    const decision =
      noProgressBlocks >= limit
        ? { kind: 'allow', header: 'STALLED', reason: `build-gate error ${noProgressBlocks} times in a row: ${error.message}` }
        : { kind: 'block', reason: `build-gate error: ${error.message}` }
    return finish(root, state, decision, 'error', noProgressBlocks, phase)
  }
}

function measure(root, phase, decision) {
  const { sessionId, transcriptPath } = observed.session
  const tasks = observed.plan?.ok ? { done: observed.plan.tasks.filter(task => task.status === 'done').length, total: observed.plan.tasks.length } : null
  let transcript = null
  try {
    transcript = fromTranscript(transcriptPath ? fs.readFileSync(transcriptPath, 'utf8') : undefined)
  } catch {
    transcript = null
  }
  recordEvent(root, {
    kind: 'stop',
    sessionId,
    phase,
    now: new Date(),
    decision: decision.kind,
    header: decision.header,
    gates: observed.gates.map(({ name, ok, seconds }) => ({ name, ok, seconds })),
    tasks,
    transcript,
  })
}

function finish(root, state, decision, print, noProgressBlocks, phase) {
  measure(root, phase, decision)
  if (decision.kind === 'block') {
    saveState(root, { ...state, lastFingerprint: print, noProgressBlocks: noProgressBlocks + 1 })
    log(root, { decision: 'block', reason: decision.reason, fingerprint: print })
    return { decision: 'block', reason: decision.reason }
  }
  if (decision.header === 'STALLED' && phase === 'build') stamp(root, decision.reason)
  saveState(root, { ...state, lastFingerprint: print, noProgressBlocks: 0 })
  log(root, { decision: 'allow', phase, header: decision.header, reason: decision.reason, fingerprint: print })
  if (phase === 'build' && decision.header?.startsWith('COMPLETE')) flipToMaintain(root)
  return null
}

function sessionStart(root) {
  const state = readJson(path.join(root, STATE), {})
  const maintain = readPhase(root) === 'maintain'
  recordEvent(root, { kind: 'session-start', sessionId: observed.session.sessionId, phase: maintain ? 'maintain' : 'build', now: new Date() })
  if (!maintain && !state.startedAt) saveState(root, { ...state, startedAt: new Date().toISOString() })
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: maintain ? MAINTAIN_CONTEXT : BUILD_CONTEXT } }
}

function main() {
  const mode = process.argv[2]
  const input = readInput()
  observed.session = { sessionId: input.session_id, transcriptPath: input.transcript_path }
  let output = null
  try {
    const { root, install } = findRoot(input.cwd ?? process.cwd())
    output = mode === 'session-start' ? sessionStart(root) : stop(root, install)
  } catch (error) {
    if (mode === 'session-start') return
    output = { decision: 'block', reason: error instanceof NotATarget ? error.message : `build-gate error: ${error.message}` }
  }
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`)
}

main()
