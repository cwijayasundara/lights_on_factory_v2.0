#!/usr/bin/env node
// Build-mode hook. `stop`: decide whether the session may end. `session-start`: start the clock, point at the skill.
// Always exits 0: a Stop hook that crashes would let the session stop silently, so errors become blocks.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { decide } from './lib/decide.mjs'
import { checkLock, parsePlan } from './lib/plan.mjs'

const NOT_A_TARGET = 'target is not a git repository with an install commit'
const REPORT = 'BUILD-REPORT.md'
const NOT_CODE = [REPORT, 'DECISIONS.md', 'BLOCKED.md', 'PLAN.md']
const STATE = '.factory/build-state.json'
const LOG = '.factory/hook-log.jsonl'
const DEFAULT_NO_PROGRESS = 8

class NotATarget extends Error {}

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout.trim() : null
}

function findRoot(cwd) {
  const root = fs.existsSync(cwd) ? git(cwd, ['rev-parse', '--show-toplevel']) : null
  if (!root) throw new NotATarget(NOT_A_TARGET)
  const install = (git(root, ['log', '--diff-filter=A', '--format=%H', '--', '.factory/build.json']) ?? '').split('\n').filter(Boolean).at(-1)
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

function protectedDiff(root, install, paths) {
  const diff = git(root, ['diff', '--stat', install, '--', ...paths]) ?? ''
  const status = git(root, ['status', '--porcelain', '--', ...paths]) ?? ''
  return [diff, status].filter(Boolean).join('\n')
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

function runGate(root, gate) {
  const result = spawnSync(gate.run, { cwd: root, shell: true, encoding: 'utf8', timeout: gate.timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 })
  if (result.error?.code === 'ETIMEDOUT' || (result.status === null && result.signal)) {
    return { name: gate.name, ok: false, tail: `${tail(result.stdout ?? '', 20)}\ntimed out after ${gate.timeoutSeconds}s` }
  }
  return { name: gate.name, ok: result.status === 0, tail: tail(`${result.stdout ?? ''}\n${result.stderr ?? ''}`) }
}

function runGates(root, config, { skipDemo }) {
  const gates = skipDemo ? config.gates : [...config.gates, config.demo]
  const results = []
  for (const gate of gates) {
    const result = runGate(root, gate)
    results.push(result)
    if (!result.ok) break
  }
  return results
}

function uncommitted(root) {
  const status = git(root, ['status', '--porcelain']) ?? ''
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '@{u}'])
  const ahead = upstream ? Number(git(root, ['rev-list', '--count', '@{u}..HEAD']) ?? '0') : 0
  return [status, ahead > 0 ? `${ahead} commit(s) not pushed to ${upstream}` : ''].filter(Boolean).join('\n')
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

function stamp(root, reason) {
  const file = path.join(root, REPORT)
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
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
  const state = readJson(path.join(root, STATE), {})
  state.startedAt ??= new Date().toISOString()
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, '.factory/build.json'), 'utf8'))
    const planFile = path.join(root, config.plan)
    const plan = fs.existsSync(planFile) ? parsePlan(fs.readFileSync(planFile, 'utf8')) : null
    const print = fingerprint(root, plan)
    const noProgressBlocks = print === state.lastFingerprint ? (state.noProgressBlocks ?? 0) : 0
    const decision = decide({
      protectedDiff: protectedDiff(root, install, config.protected),
      plan,
      lock: lockFor(root, config.plan, plan),
      demoRun: config.demo.run,
      runGates: options => runGates(root, config, options),
      uncommitted: uncommitted(root),
      report: reportState(root),
      acceptedMutants: countAccepted(root, config),
      limits: config.limits,
      guard: { noProgressBlocks, elapsedHours: (Date.now() - Date.parse(state.startedAt)) / 3600_000 },
    })
    return finish(root, state, decision, print, noProgressBlocks)
  } catch (error) {
    const noProgressBlocks = state.lastFingerprint === 'error' ? (state.noProgressBlocks ?? 0) : 0
    const limit = readJson(path.join(root, '.factory/build.json'), {})?.limits?.maxNoProgressBlocks ?? DEFAULT_NO_PROGRESS
    const decision =
      noProgressBlocks >= limit
        ? { kind: 'allow', header: 'STALLED', reason: `build-gate error ${noProgressBlocks} times in a row: ${error.message}` }
        : { kind: 'block', reason: `build-gate error: ${error.message}` }
    return finish(root, state, decision, 'error', noProgressBlocks)
  }
}

function finish(root, state, decision, print, noProgressBlocks) {
  if (decision.kind === 'block') {
    saveState(root, { ...state, lastFingerprint: print, noProgressBlocks: noProgressBlocks + 1 })
    log(root, { decision: 'block', reason: decision.reason, fingerprint: print })
    return { decision: 'block', reason: decision.reason }
  }
  if (decision.header === 'STALLED') stamp(root, decision.reason)
  saveState(root, { ...state, lastFingerprint: print, noProgressBlocks: 0 })
  log(root, { decision: 'allow', header: decision.header, reason: decision.reason, fingerprint: print })
  return null
}

function sessionStart(root) {
  const state = readJson(path.join(root, STATE), {})
  if (!state.startedAt) saveState(root, { ...state, startedAt: new Date().toISOString() })
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Build mode: invoke the build-discipline skill now, then continue PLAN.md from its next open task.',
    },
  }
}

function main() {
  const mode = process.argv[2]
  const input = readInput()
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
