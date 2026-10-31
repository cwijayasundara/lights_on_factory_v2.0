// sdlc settings hooks: read the hook event JSON on stdin, decide, and print the hook's JSON answer.
// None on Bash: session start, turn start (the baseline), post-edit (a slim per-file check), the Stop gate and model
// recording. Evidence is protected by settings deny rules and by CI, not by parsing shell commands.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  ROOT, SDLC, SENSORS_JSON, SENSORS_PATH, BUDGET_MS, IS_VENDORED, skillRef, now, exists, read, out, fail, frontmatter,
  managedSettings, scanSecrets, UNRESOLVED, readUnresolved, relPosix, sha, readGate, updateGate, type Args, type HookInput, type GateSummary,
} from './core.ts'
import { activeSlug, status, nextStep, changeType } from './lifecycle.ts'
import { snapshot, writeBaseline, readBaseline, turnDiff, showAt, diffHash } from './diffs.ts'
import { isProtected } from './sensors.ts'
import { loadConfig, runChecks, editFindings, declaresRegistry } from './check.ts'
import { formatFindings, isSource, isTest, matchesAny, warnRow, type Finding } from './model.ts'
import { sessionNote } from './githooks.ts'
import { treeStamp } from './stamp.ts'
import { runCommand } from './runs.ts'
import { policyMode, modelFamily, activeSensors, commandFor, contractGlobs, ALWAYS_ON, type Registry, type Mode } from './registry.ts'
import { contractsTouched } from './contracts.ts'
import { syncFindings } from './sync.ts'
import { queueNext } from './queue.ts'
import { readAutonomy } from './autonomy.ts'
import { recordSessionModel, recordLaunch, recordResolved, sessionModel, readModelState, modelRoleFindings, transcriptModel, transcriptContext } from './modelstate.ts'

const MODEL_STATE = path.join(SDLC, 'state', 'model.json')

// The policy for this session's model (spec §3.3).
function modeNow(registry: Registry, input: HookInput): { mode: Mode; model: string | null } {
  const model = sessionModel(MODEL_STATE, input.session_id ?? 'default', input.transcript_path, ROOT)
  return { mode: policyMode(registry, model), model }
}

// Edit-cadence command sensors on the edited file (spec §7 feedback shape): id, guide, output tail, rerun command.
// One budget for all of them, inside the 75 s PostToolUse timeout (RIG_EDIT_BUDGET_MS overrides it in specs).
function editSensorFailures(registry: Registry, rel: string): string[] {
  const out: string[] = []
  const budget = Number(process.env.RIG_EDIT_BUDGET_MS) || BUDGET_MS.edit
  let left = budget
  for (const s of activeSensors(registry, 'edit', 'continuous')) {
    if (!s.cmd || s.cadence !== 'edit' || !s.blocks) continue
    const cmd = commandFor(s, [rel])
    if (!cmd) continue
    if (left <= 0) { out.push(`${s.id}: not run, the edit sensors' ${Math.round(budget / 1000)} s budget ran out\nrerun: ${cmd}`); continue }
    const r = runCommand(cmd, { timeoutMs: Math.min(s.timeoutMs ?? left, left) })
    left -= r.ms
    if (r.exit !== 0) out.push(`${s.id}: ${s.guide}\n${r.tail.split('\n').slice(-20).join('\n')}\nrerun: ${cmd}`)
  }
  return out
}

function hookModelSwitch(input: HookInput): void {
  if (exists(SDLC) && input.to_model) recordSessionModel(MODEL_STATE, input.session_id ?? 'default', input.to_model, 'switch', now())
}

function hookAgentLaunch(input: HookInput): void {
  if (!exists(SDLC) || !input.tool_use_id) return
  recordLaunch(MODEL_STATE, { session: input.session_id ?? 'default', id: input.tool_use_id, agent: String(input.tool_input?.subagent_type ?? 'general-purpose'), requested: input.tool_input?.model ?? null, resolved: null, at: now() })
}

function hookAgentDone(input: HookInput): void {
  const resolved = input.tool_response?.resolvedModel ?? input.tool_response?.model
  if (exists(SDLC) && input.tool_use_id && resolved) recordResolved(MODEL_STATE, input.tool_use_id, resolved)
}

function readStdin(): HookInput {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}') as HookInput
  } catch {
    return {}
  }
}

type Guide = { name: string; globs: string[]; sourceOnly: boolean; body: string }

function listGuides(r: Registry): Guide[] {
  const dir = path.join(SDLC, 'guides')
  if (!exists(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => {
    const { data, body } = frontmatter(read(path.join(dir, f)))
    const tokens = (data.paths ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const globs = tokens.flatMap(t => (t === '@source' ? ['**'] : t === '@tests' ? r.paths.tests : t === '@contracts' ? contractGlobs(r.contracts) : [t]))
    return { name: data.name || f.replace(/\.md$/, ''), globs, sourceOnly: tokens.includes('@source'), body: body.trim() }
  })
}

// Progressive disclosure: a guide enters the context the first time this session edits a matching file.
function guidesFor(rel: string, session: string): string | undefined {
  const { registry } = loadConfig()
  const seen = readGate().guides[session] ?? []
  const fresh = listGuides(registry).filter(g => !seen.includes(g.name) && matchesAny(rel, g.globs) && (!g.sourceOnly || (isSource(rel, registry.paths) && !isTest(rel, registry.paths))))
  if (!fresh.length) return undefined
  updateGate(g => { g.guides[session] = [...(g.guides[session] ?? seen), ...fresh.map(f => f.name)] })
  return fresh.map(g => g.body).join('\n\n')
}

const ROUTING_LINE = `sdlc routes all work in this repo: start with ${skillRef('start')}; use superpowers skills only when an sdlc skill names one.`


function hookSessionStart(input: HookInput): void {
  if (!exists(SDLC)) return
  if (input.model) recordSessionModel(MODEL_STATE, input.session_id ?? 'default', input.model, 'session-start', now())
  if (input.source === 'compact' || input.source === 'clear') {
    updateGate(g => { delete g.guides[input.session_id ?? 'default'] })
  }
  const { registry } = loadConfig()
  const { mode, model } = modeNow(registry, input)
  const guides = listGuides(registry).map(g => g.name)
  const active = activeSlug()
  const st = active ? status(active, registry.gates, treeStamp()) : null
  const q = active ? null : queueNext()
  const context = [
    'sdlc harness is active in this repo (artifacts in .rig/).',
    ROUTING_LINE,
    `rig policy: ${mode} checks for ${model ?? 'an unknown model'} (build on ${registry.models.build}, evaluate on ${registry.models.evaluate}).`,
    declaresRegistry() ? syncFindings(registry, [], 'warn').slice(0, 5).map(f => `rig sync: ${f.message}`).join('\n') : '',
    active && st ? `Active change: ${active} (${changeType(active)}, ${st}). Next: ${nextStep(active, st)}` : q && 'slug' in q ? `Queue: start ${q.slug} now with ${skillRef('start')} ${q.path} (rung ${readAutonomy().rung})` : `No active change. Start one with ${skillRef('start')} "<request>".`,
    'Rules: plans hold interfaces and acceptance tests, never code; only the person writes .rig/changes/<slug>/approval.json; run subagents in the foreground and never end a turn while one is running; never sleep-poll; read files with Read, Grep and Glob and change them with Edit or Write; run each command as its own Bash call (no `cd`, pipes, redirects, `&&`, `;` or heredocs): unattended runs deny compound commands; at ~150k context run /compact.',
    sessionNote(),
    guides.length ? `Guides (injected when you first touch matching files): ${guides.join(', ')}` : '',
  ].filter(Boolean)
  out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context.join('\n') } }))
}

// After a Write or Edit: secret and plan checks, the edit's own sensor findings (judged against the turn baseline, so debt
// that was already there is not blamed) and, the first time this session touches a matching file, its guides.
// Unplanned work gets exactly the same checks: nothing here needs an active change.
function hookPostEdit(input: HookInput): void {
  const file = String(input.tool_input?.file_path ?? '')
  if (!file || !exists(file)) return
  const problems = scanSecrets(file)
  let edits = ''
  let guide: string | undefined
  if (exists(SDLC)) {
    const rel = relPosix(file)
    updateGate(g => { g.tool = pushUnique(g.tool, rel) })
    const { registry } = loadConfig()
    if (modeNow(registry, input).mode === 'continuous') {
      edits = formatFindings(editFindings(rel).filter(f => f.severity === 'block' && f.sensor !== 'secrets'))
      if (isSource(rel, registry.paths)) edits = [edits, ...editSensorFailures(registry, rel)].filter(Boolean).join('\n')
    }
    if (!problems.length && !edits) guide = guidesFor(rel, input.session_id ?? 'default')
  }
  if (problems.length || edits) {
    process.stderr.write(`sdlc check failed, fix before continuing:\n${[...problems, edits].filter(Boolean).join('\n')}\n`)
    process.exitCode = 2
    return
  }
  if (guide) out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: guide } }))
}

const MAX_BLOCKS = 2
const PASSED_TREES = 20

const pushUnique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item])

const more = (s: GateSummary | undefined): string[] => (s && s.warns > (s.warnRows?.length ?? 0) ? [`+${s.warns - (s.warnRows?.length ?? 0)} more`] : [])

function summarize(findings: Finding[]): GateSummary {
  const bySensor: Record<string, number> = {}
  for (const f of findings) bySensor[f.sensor] = (bySensor[f.sensor] ?? 0) + 1
  const warns = findings.filter(f => f.severity === 'warn')
  return { at: now(), blocks: findings.filter(f => f.severity === 'block').length, warns: warns.length, bySensor, warnRows: warns.slice(0, 5).map(warnRow) }
}

// The person typed /rig:approve <target> (or /rig-approve): a hook sees only what the person typed, never a model's tool call, so this is
// as human-only as the skill, and it works in a session that started before the skill was installed. A bare command is left to the
// skill, which asks what to approve; approving here first would make its Cancel undo nothing. The model is told to carry on with
// /rig:build, so the build starts without a second command.
function runSdlc(args: string[], human = false): { code: number; text: string } {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1] ?? '', ...args], { encoding: 'utf8', env: { ...process.env, ...(human ? { SDLC_HUMAN: '1' } : {}) } })
  return { code: r.status ?? 1, text: `${r.stdout}${r.stderr}`.trim() }
}
function approveTyped(typedArgs: string): void {
  const slug = typedArgs.trim().split(/\s+/).filter(Boolean)[0]
  if (!slug) return
  const say = (text: string): void => out(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }))
  const r = runSdlc(['approve', slug], true)
  say(`rig: the person typed ${skillRef('approve')} and rig ${r.code === 0 ? 'recorded it' : 'refused it'}:\n${r.text}\nTell them the result in one line${r.code === 0 ? `, then continue with ${skillRef('build')} ${slug}` : ' and stop'}. Do not run ${skillRef('approve')} or sdlc.ts approve yourself.`)
}

// /rig-start on a context over 100k tokens or a main thread off the build model: say so before the work begins (shop_app sprint 1, 2026-10-28).
const CONTEXT_NUDGE = 100_000
function startNudge(input: HookInput): string {
  if (!/^\s*\/rig[:-]start\b/.test(String(input.prompt ?? ''))) return ''
  const { registry } = loadConfig(), tp = typeof input.transcript_path === 'string' ? input.transcript_path : undefined
  const n = transcriptContext(tp), main = transcriptModel(tp), fam = (m: string): string => modelFamily(m, registry.policy)
  return [
    n !== null && n > CONTEXT_NUDGE ? `context is ~${Math.round(n / 1000)}k tokens: run /clear, then this command again` : '',
    main && fam(main) !== fam(registry.models.build) ? `the main thread runs on ${main}; this repo builds on ${registry.models.build}: /model ${registry.models.build}` : '',
  ].filter(Boolean).join('; ')
}

// Each prompt starts a turn: record the tree and reset the per-turn gate, so Stop diffs exactly this turn's changes.
// Warnings the last turn left are handed to the agent once, here, because a passing Stop cannot show them to it.
function hookPromptSubmit(input: HookInput = {}): void {
  if (!exists(SDLC)) return
  const typed = /^\s*\/rig[:-]approve(?:[ \t]+([^\n]*?))?\s*$/.exec(String(input.prompt ?? ''))
  const last = readGate().last
  const carry = !typed && last && !last.shown && last.warns > 0 && last.warnRows?.length ? last.warnRows : null
  const snap = snapshot()
  if (snap) writeBaseline(snap)
  updateGate(g => {
    Object.assign(g, { turn: snap?.at ?? now(), blocks: {}, passed: {}, tool: [] })
    if (carry && g.last) g.last.shown = true
  })
  if (typed) approveTyped(typed[1] ?? '')
  const nudge = startNudge(input)
  if (carry || nudge) {
    out(JSON.stringify({
      ...(carry ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `rig: the last turn left ${last?.warns} warning(s) that did not block. Fix them if they are yours:\n${[...carry, ...more(last)].map(r => `- ${r}`).join('\n')}` } } : {}),
      ...(nudge ? { systemMessage: `rig: ${nudge}` } : {}),
    }))
  }
}

// The end-of-turn gate: every built-in sensor on this turn's diff, then the fast commands. Work with no active change gets
// the same sensors; it is not recorded as a change.
// halt: the gate printed a block (or gave up) and the turn is not continued. warn: a systemMessage the caller prints, so
// a turn that only warned and is also continued emits one JSON object, not two.
function hookStop(input: HookInput = {}): { halt: boolean; warn?: string } {
  if (!exists(SDLC)) return { halt: false }
  const snap = readBaseline()
  if (!snap) return { halt: false }
  const { registry, rules, errors } = loadConfig()
  const { mode, model } = modeNow(registry, input)
  const gate = readGate()
  const diffs = turnDiff(snap).filter(d => isSource(d.file, registry.paths) || isProtected(d.file) || matchesAny(d.file, contractGlobs(registry.contracts)))
  if (!diffs.length) return { halt: false }
  const hash = diffHash(diffs) + sha(read(SENSORS_PATH) + read(path.join(SDLC, 'rules.json'))) + mode
  if (gate.passed.main === hash) return { halt: false }
  const slug = activeSlug()
  // The fast commands are keyed by the whole tree, not this turn's diff: a tree that already passed them (an edit undone, a
  // file touched and restored, the same state reached from another turn) skips them, and only the sensors judge the diff.
  const stamp = treeStamp()
  const treePassed = stamp !== null && gate.trees.includes(stamp)
  const result = runChecks({
    point: 'stop', diffs, config: registry, rules, slugs: slug ? [slug] : [], commands: treePassed || mode === 'final' ? 'none' : 'fast', budgetMs: BUDGET_MS.stop,
    before: f => showAt(snap.sha, f) ?? '', toolEdited: new Set(gate.tool), base: null, ratchet: true, ratchetWrite: 'write',
    contracts: mode === 'continuous' && contractsTouched(registry.contracts, diffs.map(d => d.file)), gates: registry.gates,
  })
  const configBlocks: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file' }))
  const kept = mode === 'final' ? result.findings.filter(f => (ALWAYS_ON as string[]).includes(f.sensor)) : result.findings
  const roleOn = registry.sensors.some(s => s.id === 'model-role' && s.enabled)
  const roles = roleOn ? modelRoleFindings(registry, model, readModelState(MODEL_STATE).launches.filter(l => l.session === (input.session_id ?? 'default'))) : []
  const findings = [...configBlocks, ...kept, ...roles]
  const blocks = findings.filter(f => f.severity === 'block')
  gate.last = summarize(findings)
  // Write back only what this hook owns: edits recorded while the checks ran must survive.
  const save = (): void => updateGate(g => { g.last = gate.last; if (gate.passed.main) g.passed.main = gate.passed.main; if (gate.blocks.main) g.blocks.main = gate.blocks.main; g.trees = gate.trees })
  if (!blocks.length) {
    gate.passed.main = hash
    if (stamp && !treePassed && mode === 'continuous') gate.trees = [...gate.trees, stamp].slice(-PASSED_TREES)
    save()
    if (exists(UNRESOLVED)) fs.rmSync(UNRESOLVED)
    const warns = gate.last?.warnRows ?? []
    return warns.length ? { halt: false, warn: `rig: ${gate.last?.warns} warning(s), not blocking: ${[...warns, ...more(gate.last)].join(' | ')}` } : { halt: false }
  }
  const attempt = (gate.blocks.main ?? 0) + 1
  const survived = attempt > 1 ? survivors(blocks) : []
  fs.writeFileSync(UNRESOLVED, JSON.stringify({ at: now(), slug, findings: blocks }, null, 2) + '\n')
  if (attempt > MAX_BLOCKS) {
    save()
    out(JSON.stringify({ systemMessage: `sdlc quality gate: ${blocks.length} problem(s) unresolved after ${MAX_BLOCKS} attempts (.rig/unresolved.json). Ship and CI will refuse until they are fixed or the person waives them.` }))
    return { halt: true }
  }
  gate.blocks.main = attempt
  save()
  out(JSON.stringify({ decision: 'block', reason: `sdlc quality gate (attempt ${attempt}/${MAX_BLOCKS}): fix these before you finish.\n${formatFindings(findings)}${premiseAsk(survived)}` }))
  return { halt: true }
}

// Blocks this turn's last Stop also raised (attempt > 1: this turn wrote unresolved.json), matched without the numbers a fix may
// move (the line, "grew to 15 lines" becoming 13) and listed as they read now.
const blockText = (f: Finding): string => `${f.sensor} ${f.file ?? ''}: ${f.message}`
const survivors = (blocks: Finding[]): string[] => { try { const key = (f: Finding): string => blockText(f).replace(/\d+/g, '#'); const old = new Set(readUnresolved().map(key)); return [...new Set(blocks.filter(f => old.has(key(f))).map(blockText))] } catch { return [] } }
// Attack the premise: a second fix aimed by the same wrong belief fails the same way, so it names that belief before editing.
const premiseAsk = (survived: string[]): string => survived.length ? `\n\nStill failing after your last fix:\n${survived.map(s => `- ${s}`).join('\n')}\nThat fix rested on a premise that is wrong. Before you edit again, write that premise in one sentence, check it against the check's output and the code it judges, and aim the next fix at what the check shows. If the turn ends unresolved, give the person that sentence.` : ''

const HOOKS: Record<string, (input: HookInput) => void> = {
  'session-start': hookSessionStart,
  'post-edit': hookPostEdit,
  'model-switch': hookModelSwitch,
  'agent-launch': hookAgentLaunch,
  'agent-done': hookAgentDone,
  'prompt-submit': i => hookPromptSubmit(i),
  stop: i => {
    const r = hookStop(i)
    if (!r.halt && r.warn) out(JSON.stringify({ systemMessage: r.warn }))
  },
}

// A standalone repo registers its own copy's hooks in .claude/settings.json. The plugin's copy of a hook steps aside only
// when the project registers that same hook, so none runs twice and none is lost; unreadable settings keep the plugin's, and so does
// managed allowManagedHooksOnly, which blocks project hooks (only a force-enabled plugin's hooks run).
type SettingsHooks = { hooks?: Record<string, { hooks?: { command?: unknown }[] }[]> }
function runsOwnHook(name: string): boolean {
  if (IS_VENDORED) return false
  // RIG_MANAGED_HOOKS_ONLY is the template's marker for server-managed settings, which are not visible on disk.
  if (process.env.RIG_MANAGED_HOOKS_ONLY === '1' || managedSettings().allowManagedHooksOnly === true) return false
  try {
    const { hooks = {} } = JSON.parse(read(path.join(ROOT, '.claude', 'settings.json')) || '{}') as SettingsHooks
    const own = new RegExp(`\\.rig/bin/sdlc\\.ts"? hook ${name}$`)
    return Object.values(hooks).flat().some(g => g.hooks?.some(h => typeof h.command === 'string' && own.test(h.command.trim())))
  } catch {
    return false
  }
}

// Hooks rig no longer registers (spec §7): a settings file vendored before step 4a may still call them.
const RETIRED_HOOKS = ['subagent-start', 'subagent-stop', 'skill-failed']

export function cmdHook(args: Args): void {
  if (RETIRED_HOOKS.includes(args.pos[0] ?? '')) return
  const handler = HOOKS[args.pos[0] ?? '']
  if (!handler) fail(`unknown hook ${args.pos[0]}`)
  if (runsOwnHook(args.pos[0] ?? '')) return
  handler(readStdin())
}
