// Orchestrates sensors at a firing point (stop, ship, ci): one set of checks everywhere, so local == CI.
import fs from 'node:fs'
import path from 'node:path'
import { waiverLive,
  ROOT, SDLC, CHANGES, WAIVERS, SENSORS_JSON, BUDGET_MS, readJson, exists, read, out, fail, git, toPosix, optString, readJsonl, defaultBase, checkSlug, skillRef,
  type Args, type Waiver,
} from './core.ts'
import { parseRules, formatFindings, warnLines, matchesAny, isTest, isSource, ghPages, planFiles, type FileDiff, type Finding, type Rule } from './model.ts'
import { withoutFixtures, testTamper, suppressions, layering, size, secretsInDiff, rulesSensor, harnessTamper, isProtected, behaviourIds, behaviourText, missingBehaviours } from './sensors.ts'
import { readBaseline, snapshot, turnDiff, fileDiff, branchDiff, showAt, fileLines, stagedDiff, showStaged } from './diffs.ts'
import { runCommand, recordRun, normCmd } from './runs.ts'
import { withBaseTree } from './basetree.ts'
import { activeSlug, approvalState, changeType, unapprovedBuild } from './lifecycle.ts'
import { approvedLayers } from './arch.ts'
import { journeyFindings, draftApps } from './app.ts'
import { scopeFindings, intentScope } from './scope.ts'
import { RATCHET_FILE, lastNumber, loadRatchets, judge, tighten, type RatchetWrite } from './counts.ts'
import { isRegistryShape, parseRegistry, defaultRegistry, updateKnownRed, activeSensors, commandFor, builtinOptions, type Changed, inertSensors, type Registry, type RegistrySensor, type Cadence, type Inert } from './registry.ts'
import { frozenFindings, runContracts } from './contracts.ts'
import { syncFindings } from './sync.ts'
import { riskOf, formatRisk, type Risk } from './risk.ts'
import { changeHistory, breaker } from './reverts.ts'
import { parseAccess } from './chartcheck.ts'
import { ARCH_REL } from './product.ts'

type Point = 'stop' | 'commit' | 'ship' | 'ci'
type CheckInput = {
  point: Point
  diffs: FileDiff[]
  config: Registry
  rules: Rule[]
  slugs: string[]
  commands: 'fast' | 'full' | 'none'
  budgetMs: number
  before: (file: string) => string
  toolEdited?: Set<string>
  base: string | null
  ratchet?: boolean
  ratchetWrite?: RatchetWrite // tighten .rig/ratchets.json: never at CI or against another ref's config
  after?: (file: string) => string // the text being judged; defaults to the working tree (commit passes the index)
  gates?: { plan: boolean } // the plan gate; absent: on
  contracts?: boolean // run the contract commands (validate, then run); absent: at ship and ci only
  drifted?: boolean // the diff is not the working tree (a push of other commits), so {changed} sensors, run on disk, skip
}
type CheckResult = { findings: Finding[]; blocks: Finding[]; warns: Finding[]; waived: number }

const TAIL_IN_FINDING = 15

// The pre-registry format is recognised by its keys; anything else (`{}`, a registry missing its sensors list, broken
// JSON) goes to parseRegistry, which reports a parse error as one.
const OLD_KEYS = ['fast', 'full', 'levels', 'quality', 'scopes', 'behavioral', 'limits', 'layers', 'githooks', 'consumers', 'scopeLimit', 'affected', 'sparseBase', 'budget', 'routing', 'points', 'value', 'ratchet', 'evals', 'bands', 'build', 'ci', 'idleGapMs']
const isOldShape = (raw: string): boolean => { try { const v: unknown = JSON.parse(raw); return typeof v === 'object' && v !== null && !Array.isArray((v as { sensors?: unknown }).sensors) && Object.keys(v).some(k => OLD_KEYS.includes(k)) } catch { return false } }
// A repo that declares a registry keeps its CLAUDE.md guides in sync (spec §5); one with none declared has nothing to sync.
export const declaresRegistry = (): boolean => isRegistryShape(read(path.join(ROOT, SENSORS_JSON)))
const OLD_SHAPE = '.rig/sensors.json uses the pre-registry format; run sdlc.ts init --stack to print a registry for this repo, then land it on the trunk as a reviewed harness change (spec 2026-10-16 §3)'

// With a ref (CI), the registry comes from the base branch, so a PR cannot loosen the rules it is judged by.
export function loadConfig(ref: string | null = null): { registry: Registry; rules: Rule[]; errors: string[] } {
  if (ref && git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null) return { registry: defaultRegistry(), rules: [], errors: [`config ref ${ref} does not exist`] }
  const text = (rel: string): string => (ref ? git(['show', `${ref}:${rel}`]) ?? '' : read(path.join(ROOT, rel)))
  const r = parseRules(text('.rig/rules.json'))
  const raw = text(SENSORS_JSON)
  const ruleErrors = r.errors.map(e => `rules.json: ${e}`)
  if (isOldShape(raw)) return { registry: defaultRegistry(), rules: r.rules, errors: [OLD_SHAPE, ...ruleErrors] }
  const p = parseRegistry(raw)
  // The approved layer rules (read from the same ref as the rest of the config, so a PR cannot loosen them) fill an empty layering option.
  const lay = p.registry.sensors.find(x => x.builtin && x.id === 'layering'), approved = approvedLayers(text('.rig/layers.approved.json'))
  if (lay && approved.length && !lay.options?.layers) lay.options = { ...lay.options, layers: approved }
  p.registry.ratchets = loadRatchets(text(RATCHET_FILE))
  return { registry: p.registry, rules: r.rules, errors: [...p.errors.map(e => `sensors: ${e}`), ...ruleErrors] }
}

// Once a known-red command passes, it blocks from then on: the only automatic edit to sensors.json, and it only tightens.
function ratchet(cleared: string[]): void {
  const file = path.join(ROOT, SENSORS_JSON)
  if (!exists(file)) return
  try {
    const text = read(file)
    const next = updateKnownRed(text, [], cleared)
    if (JSON.stringify((JSON.parse(next) as { knownRed?: unknown }).knownRed) !== JSON.stringify((JSON.parse(text) as { knownRed?: unknown }).knownRed ?? [])) fs.writeFileSync(file, next)
  } catch { /* unparseable: leave it */ }
}

// Built-ins a team turned off are dropped; built-ins it made advisory warn.
function builtinsApplied(findings: Finding[], r: Registry): Finding[] {
  const builtin = (id: string) => r.sensors.find(s => s.builtin && s.id === id)
  return findings.filter(f => builtin(f.sensor)?.enabled !== false).map(f => (f.severity === 'block' && builtin(f.sensor)?.blocks === false ? { ...f, severity: 'warn' as const } : f))
}

// A ratchet sensor's number against its baseline: worse blocks (warns when the sensor is advisory); better or first tightens the baseline locally.
function ratchetFinding(s: RegistrySensor, dir: 'down' | 'up', value: number | null, base: Record<string, number>, write: RatchetWrite): Finding[] {
  if (value === null) return [{ sensor: s.id, severity: s.blocks ? 'block' : 'warn', message: `${s.id} is a ratchet but printed no number on its last line (a plain decimal is expected)`, fix: `make the command end with the count: ${s.cmd}` }]
  const was = base[s.id]
  if (was === undefined) {
    if (write) tighten(s.id, dir, value, write)
    // At CI there is nothing to compare with and nothing may be written: say so, so a missing baseline does not read as a pass.
    else return [{ sensor: s.id, severity: 'warn', message: `${s.id} is a ratchet with no baseline on the base branch, so ${value} was not judged`, fix: `run the checks locally and commit ${RATCHET_FILE}, then land it on the trunk` }]
    return []
  }
  const j = judge(dir, value, was)
  if (j === 'better' && write) tighten(s.id, dir, value, write)
  return j === 'worse' ? [{ sensor: s.id, severity: s.blocks ? 'block' : 'warn', message: `${s.id} regressed: ${value}, baseline ${was} (${dir === 'down' ? 'lower' : 'higher'} is better): ${s.guide}`, fix: `bring ${s.id} back to ${was} or better; only a person raises a baseline, in ${RATCHET_FILE}` }] : []
}

// The registry's command sensors due at this cadence (spec §3.1), in order, inside one time budget. A sensor with
// "blocks": false warns; a knownRed one warns while it fails and leaves knownRed once it passes.
export function runSensors(r: Registry, at: Cadence, slug: string | null, budgetMs: number, allowRatchet = false, skip?: Set<string>, ratchetWrite: RatchetWrite = null, changed: Changed[] | null = null): Finding[] {
  const findings: Finding[] = []
  const cleared: string[] = []
  let left = budgetMs
  for (const s of activeSensors(r, at, 'continuous')) {
    const cmd = commandFor(s, null, changed)
    if (!cmd || skip?.has(normCmd(cmd))) continue
    const known = r.knownRed.includes(s.id)
    if (left <= 0) {
      findings.push({ sensor: s.id, severity: s.blocks ? 'block' : 'warn', message: `${s.id} not run: the ${Math.round(budgetMs / 1000)} s budget ran out`, fix: `make ${s.id} faster or move it to a later cadence in .rig/sensors.json`, outOfTime: true })
      continue
    }
    const row = runCommand(cmd, { timeoutMs: Math.min(left, s.timeoutMs ?? left) })
    left -= row.ms
    if (slug) recordRun(slug, { ...row, sensor: s.id, source: at === 'turn' ? 'gate' : 'ship' })
    if (row.exit === 0) {
      if (known) cleared.push(s.id)
      if (s.ratchet) findings.push(...ratchetFinding(s, s.ratchet, lastNumber(row.tail), r.ratchets ?? {}, ratchetWrite))
      continue
    }
    const tail = row.tail.split('\n').slice(-TAIL_IN_FINDING).map(t => '      ' + t).join('\n')
    findings.push({
      sensor: s.id,
      severity: !s.blocks || (known && !row.timedOut) ? 'warn' : 'block',
      message: `${s.id} failed (exit ${row.exit}${row.timedOut ? ', timed out' : ''}): ${s.guide}\n${tail}`,
      fix: known && !row.timedOut ? 'known red before this change: fix it when you can' : `fix what it reports, then rerun: ${cmd}`,
      ...(row.timedOut ? { outOfTime: true as const } : {}),
    })
  }
  if (cleared.length && allowRatchet) ratchet(cleared)
  return findings
}


// At CI only a change the PR adds (its folder is absent in the base) can waive, and only inside its plan's files or its own folder:
// an older change's wildcard waiver must not cover what a later PR does.
function ciScope(slug: string, base: string | null | undefined): ((file: string | undefined) => boolean) | null {
  if (!base || showAt(base, `.rig/changes/${slug}/intent.md`) !== null) return null
  const entries = planFiles(read(path.join(CHANGES, slug, 'plan.md')))
  const own = `.rig/changes/${slug}/`
  return file => file !== undefined && (file.startsWith(own) || entries.some(e => e.endsWith('/') ? file.startsWith(e) : file === e || matchesAny(file, [e])))
}

// The PR supplies its own waivers.jsonl rows, so at CI harness-tamper on harness files and contracts findings are never waivable: harness changes land on the trunk first, and the behavioural gate stays independent.
function applyWaivers(findings: Finding[], slugs: string[], ci?: { base: string | null | undefined }): CheckResult {
  const scopes = new Map(slugs.map(s => [s, ci ? ciScope(s, ci.base) : () => true] as const))
  // An exception ends: past its expiry a waiver no longer covers anything, so the finding it hid comes back.
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => slugs.includes(w.slug) && scopes.get(w.slug) !== null && waiverLive(w))
  // Never waivable: plan-gate (only a person's approval clears it); at CI also contracts and harness-tamper on harness files.
  const never = (f: Finding): boolean => f.sensor === 'plan-gate' || (Boolean(ci) && ((f.sensor === 'harness-tamper' && (!f.file || isProtected(f.file))) || f.sensor === 'contracts'))
  const waived = (f: Finding): boolean => waivers.some(w => w.sensor === f.sensor && (w.file === '*' || w.file === f.file) && !never(f) && (scopes.get(w.slug) as (file: string | undefined) => boolean)(f.file))
  const kept = findings.filter(f => !waived(f))
  return { findings: kept, blocks: kept.filter(f => f.severity === 'block'), warns: kept.filter(f => f.severity === 'warn'), waived: findings.length - kept.length }
}

// Only the tests this branch adds or changes can show a behaviour is covered: an old test naming B1 proves nothing new.
function testCorpus(config: Registry, diffs: FileDiff[]): string {
  return diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config.paths)).map(d => read(path.join(ROOT, d.file))).join('\n')
}

// Proof against the base, recomputed (no log entry can fake it): the branch's changed tests run on top of the base code.
// 'red' (feature, bugfix, incident, greenfield): they must FAIL there, so they prove the change.
// 'green' (refactor): they must PASS there, so they pin the old behaviour the refactor preserves.
function proofOnBase(slug: string, config: Registry, diffs: FileDiff[], base: string, mode: 'red' | 'green', budgetMs: number): Finding[] {
  const block = (message: string, fix: string): Finding[] => [{ sensor: 'red-proof', severity: 'block', message, fix }]
  const id = String(builtinOptions(config, 'red-proof').sensor ?? 'unit')
  const unit = config.sensors.find(s => s.id === id && s.cmd && s.enabled)
  const cmd = unit ? commandFor(unit, null) : null
  const tests = diffs.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, config.paths)).map(d => d.file)
  // Support files (fixtures, testdata) travel with the tests, or a test that needs them would fail on the base for the wrong reason.
  const overlay = diffs.filter(d => d.status !== 'D' && !d.binary && (isTest(d.file, config.paths) || matchesAny(d.file, config.paths.testSupport))).map(d => d.file)
  const t0 = Date.now()
  const left = (): number => Math.max(1000, budgetMs - (Date.now() - t0))
  if (!tests.length) return mode === 'red' ? block('no test file changed, so nothing proves this change', 'write the failing test first') : []
  if (!cmd) return [{ sensor: 'red-proof', severity: 'warn', message: `no unit sensor (${id}) to run the new tests on the base`, fix: 'add a command sensor with id "unit", or set red-proof options.sensor' }]
  const tree = withBaseTree(base, tmp => {
    const sanity = runCommand(cmd, { cwd: tmp, timeoutMs: left() })
    recordRun(slug, { ...sanity, sensor: 'red-proof', source: 'ship' })
    if (sanity.exit !== 0 || sanity.timedOut) return block("can't establish red: the tests fail on the base even without the new tests", 'make the test command pass from a clean checkout of the base (dependencies, fixtures), or the person waives red-proof')
    for (const t of overlay) {
      fs.mkdirSync(path.dirname(path.join(tmp, t)), { recursive: true })
      fs.copyFileSync(path.join(ROOT, t), path.join(tmp, t))
    }
    const run = runCommand(cmd, { cwd: tmp, timeoutMs: left() })
    if (run.timedOut) return block('proof timed out: the tests did not finish on the base within the budget', 'make the test command faster, or the person waives red-proof')
    recordRun(slug, mode === 'red' ? { ...run, sensor: 'red-proof', expectFail: true, source: 'ship' } : { ...run, sensor: 'red-proof', source: 'ship' })
    if (mode === 'red' && run.exit === 0) return block('the new tests already pass on the base: they prove nothing about this change', 'write a test that fails without the change, then make it pass')
    if (mode === 'green' && run.exit !== 0) return block("the refactor's tests fail on the base: they do not describe the behaviour being preserved", 'write characterization tests that pass on the old code first, then refactor under them')
    return []
  }, { prefix: 'rig-red-' })
  return tree.ok ? tree.value : block(tree.error, 'run `git worktree prune` and retry, check permissions for symlinks, or the person waives red-proof')
}

function shipVerdicts(slug: string, config: Registry, diffs: FileDiff[], base: string | null, budgetMs: number, planGate: boolean): Finding[] {
  const dir = path.join(CHANGES, slug)
  if (!exists(dir)) return [{ sensor: 'traceability', severity: 'block', message: `unknown change ${slug}`, fix: 'pass a slug that exists under .rig/changes/' }]
  const findings: Finding[] = []
  const state = approvalState(slug)
  if (planGate && state !== 'approved') findings.push({ sensor: 'plan-gate', severity: 'block', message: `${slug}: the plan is ${state === 'missing' ? 'not approved' : 'changed since it was approved'}`, fix: `a person reviews spec.md and plan.md and runs ${skillRef('approve')} ${slug}` })
  const spec = read(path.join(dir, 'spec.md'))
  const ids = behaviourIds(spec, 'Behaviours')
  for (const id of missingBehaviours(ids, ids.length ? testCorpus(config, diffs) : '')) {
    const what = behaviourText(spec, 'Behaviours', id)
    findings.push({ sensor: 'traceability', severity: 'block', message: `${id}${what ? ` (${what})` : ''} has no test that names it`, fix: `add a test whose name or comment says ${id} and proves it` })
  }
  // Red for new behaviour, green-on-base for a refactor, nothing extra for a chore (its full suite already ran).
  const type = changeType(slug)
  const mode = type === 'feature' || type === 'bugfix' ? 'red' : type === 'refactor' ? 'green' : null
  if (mode && !base) findings.push({ sensor: 'red-proof', severity: 'warn', message: 'no base branch found; proof against the base skipped', fix: 'pass --base <branch>' })
  else if (mode && base) findings.push(...proofOnBase(slug, config, diffs, base, mode, budgetMs))
  return findings
}

const onDisk = (f: string): string => read(path.join(ROOT, f))

// The built-in diff sensors every point runs, edit time included; harness-tamper is added by the callers that judge a turn or more.
function builtinFindings(diffs: FileDiff[], config: Registry, rules: Rule[], lineCounts: Record<string, number>, point: Parameters<typeof size>[3], slugs: string[], touched: string[], after: (f: string) => string, base: string | null, planGate = true): Finding[] {
  // At ship and CI the scope comes from the base branch (the PR cannot edit it); a slug with no intent there falls back to the working tree.
  const scopeOf = (slug: string): ReturnType<typeof intentScope> => ((point === 'ship' || point === 'ci') && base ? intentScope(slug, rel => showAt(base, rel) ?? '', (git(['ls-tree', '-r', '--name-only', base, '--', '.rig/product/sprints']) ?? '').split('\n')) : null) ?? intentScope(slug)
  const pattern = withoutFixtures(diffs, config)
  return [
    ...testTamper(pattern, config), ...suppressions(pattern, config), ...layering(pattern, config), ...size(diffs, config, lineCounts, point),
    ...secretsInDiff(pattern), ...rulesSensor(pattern, rules), ...frozenFindings(slugs, touched, after), ...unapprovedBuild(slugs, touched, planGate && (point === 'edit' || point === 'stop')), ...scopeFindings(diffs, slugs, config.paths, point, scopeOf),
  ]
}

export function runChecks(i: CheckInput): CheckResult {
  const { diffs, config } = i
  // A commit judges a partial diff, like Stop: same severities, same sensors. Only its text source differs.
  const point = i.point === 'commit' ? 'stop' : i.point
  const after = i.after ?? onDisk
  const findings: Finding[] = [
    ...builtinFindings(diffs, config, i.rules, fileLines(diffs.filter(d => d.status !== 'D').map(d => d.file), after), point, i.slugs, diffs.flatMap(d => d.from ? [d.file, d.from] : [d.file]), after, i.base, i.gates?.plan ?? true),
    ...harnessTamper(diffs, { point, toolEdited: i.toolEdited, before: i.before, after }),
  ]
  // A diff whose plan the person approved is big by design: the diff-size limit warns instead of blocking.
  if (i.slugs.length && i.slugs.every(s => approvalState(s) === 'approved')) {
    for (const f of findings) if (f.sensor === 'size' && !f.file) f.severity = 'warn'
  }
  if (point !== 'stop') for (const slug of i.slugs) findings.push(...shipVerdicts(slug, config, diffs, i.base, i.budgetMs, i.gates?.plan ?? true))
  // Contracts (spec §6): ship and CI always, commit always, a turn only when it reaches a contract. Validate gates run.
  const c = config.contracts
  if ((i.contracts ?? (i.point === 'ship' || i.point === 'ci')) && (c.validate || c.run)) findings.push(...runContracts(c, i.point === 'stop' ? i.budgetMs : Math.max(i.budgetMs, 600_000)))
  const at: Cadence = i.commands === 'fast' ? 'turn' : i.point === 'commit' ? 'commit' : 'ci'
  const changed = i.drifted ? null : diffs.filter(d => d.status !== 'D' && !d.binary && isSource(d.file, config.paths) && !isTest(d.file, config.paths)).map(d => ({ file: d.file, lines: d.added.map(l => l.n) }))
  if (i.commands !== 'none') findings.push(...runSensors(config, at, i.point === 'ci' ? null : i.slugs[0] ?? null, i.budgetMs, Boolean(i.ratchet) && i.point !== 'ci', new Set([c.validate, c.run].filter(Boolean).map(normCmd)), i.point === 'ci' ? null : i.ratchetWrite ?? null, changed))
  // Journeys run where the heavier sensors do (verify, ship, CI), never at a commit or a turn.
  if (at === 'ci' && i.commands === 'full') findings.push(...journeyFindings(i.budgetMs, undefined, i.point === 'ci'))
  const result = applyWaivers(builtinsApplied(findings, config), i.slugs, i.point === 'ci' ? { base: i.base } : undefined)
  return result
}

// The cheap per-file subset, for the PostToolUse hook.
export function editFindings(rel: string): Finding[] {
  const snap = readBaseline()
  if (!snap) return []
  const { registry: config, rules } = loadConfig()
  const slugs = [activeSlug()].filter((s): s is string => Boolean(s))
  return applyWaivers(builtinsApplied(builtinFindings(fileDiff(snap, rel), config, rules, fileLines([rel]), 'edit', slugs, [rel], onDisk, null, config.gates.plan), config), slugs).findings
}

// The changes a diff carries evidence for, as CI reads them.
export const slugsIn = (diffs: FileDiff[]): string[] => [...new Set(diffs.map(d => /^\.rig\/changes\/([^/]+)\//.exec(d.file)?.[1]).filter((s): s is string => Boolean(s)))]

// Waivers and approvals are trusted, not recomputed, so CI shows each row a PR adds for a person to review.
const HUMAN_FILES = [['.rig/waivers.jsonl', 'waiver']] as const
// PR-controlled text: one line, no backticks or angle brackets (it cannot close the summary fence or start a
// `::` workflow command, since every row is printed after "  - "), and capped.
const clean = (v: unknown): string => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/`/g, "'").replace(/[<>]/g, '_').replace(/"/g, "'").slice(0, 200)
function humanRowsAdded(base: string): string[] {
  const rows: string[] = []
  for (const [rel, kind] of HUMAN_FILES) {
    const before = new Set((showAt(base, rel) ?? '').replace(/\r\n/g, '\n').split('\n').filter(Boolean))
    for (const line of read(path.join(ROOT, rel)).split('\n').filter(l => l && !before.has(l))) {
      let r: Record<string, unknown> = {}
      try { r = JSON.parse(line) as Record<string, unknown> } catch { /* shown raw below */ }
      const s = (k: string): string => clean(r[k] ?? '?')
      rows.push(!Object.keys(r).length ? `${kind} (unparseable): ${clean(line)}` : `waiver ${s('slug')}: ${s('sensor')} ${s('file')} "${s('reason')}" by ${s('by')}`)
    }
  }
  // approval.json: every one the PR adds or edits is a person's decision CI cannot verify from the file alone.
  // A sprint chart approval (.rig/product/sprints/sprint-N/approval.json) is the same kind of row.
  for (const f of (git(['diff', '--name-only', base, 'HEAD', '--', '.rig/changes', '.rig/product/sprints']) ?? '').split('\n')) {
    const name = /^\.rig\/changes\/([^/]+)\/approval\.json$/.exec(f)?.[1] ?? (/^\.rig\/product\/sprints\/sprint-(\d+)\/approval\.json$/.exec(f)?.[1] ? `chart-${/^\.rig\/product\/sprints\/sprint-(\d+)\//.exec(f)?.[1]}` : undefined)
    if (!name) continue
    const by = String(readJson<{ by?: unknown } | null>(path.join(ROOT, f), null)?.by ?? '?') // deleted or unreadable: still a row
    rows.push(`approval ${name} by ${clean(by)}`)
  }
  // sprint-N/waivers.json: each chart waiver row the PR adds is a person accepting a review finding as it stands.
  for (const f of (git(['diff', '--name-only', base, 'HEAD', '--', '.rig/product/sprints']) ?? '').split('\n')) {
    const n = /^\.rig\/product\/sprints\/sprint-(\d+)\/waivers\.json$/.exec(f)?.[1]
    if (!n) continue
    const list = (p: string | null): Record<string, unknown>[] => { try { const v = JSON.parse(p ?? '[]') as unknown; return Array.isArray(v) ? v as Record<string, unknown>[] : [] } catch { return [] } }
    const before = new Set(list(git(['show', `${base}:${f}`])).map(w => JSON.stringify(w)))
    const added = list(exists(path.join(ROOT, f)) ? read(path.join(ROOT, f)) : null).filter(w => !before.has(JSON.stringify(w)))
    for (const w of added.length ? added : [{}]) rows.push(Object.keys(w).length ? `chart waiver chart-${n} finding ${clean(w.finding ?? '?')}: "${clean(w.reason ?? '?')}" by ${clean(w.by ?? '?')}` : `chart waiver chart-${n} (removed or unreadable)`)
  }
  // autonomy.json: the rung is a person's decision; every PR that adds or edits it is a row, naming the newest history row's author.
  if ((git(['diff', '--name-only', base, 'HEAD', '--', '.rig/autonomy.json']) ?? '').trim()) {
    let by = '?'
    try { by = String((JSON.parse(read(path.join(ROOT, '.rig/autonomy.json'))) as { history?: { by?: unknown }[] }).history?.at(-1)?.by ?? 'rig init') } catch { /* deleted or unreadable: still a row */ }
    rows.push(`autonomy by ${clean(by)}`)
  }
  return rows
}

// A PR file cannot prove who wrote an approval row (the model commits as the developer): CI asks GitHub for an approving review of the head commit by someone other than the author.
// A lead named in the base config's humanApproval.selfApprovers may instead pass with the lead override: this run's `ai-review` job succeeded and its `lead-override` job
// (gated by a GitHub Environment whose required reviewer clicks in the web UI) succeeded, both on the head commit.
// The one path where a PR merges with no person (proposal 2026-10-27 B2, C2). Every input is the base's or GitHub's, never the PR's,
// and every lookup that fails refuses: the unattended path fails closed.
type Who = { number: number; author: string; sender: string; repo: string; headSha: string; sameRepo: boolean }
type Pull = { number?: number; user?: { login?: string }; head?: { sha?: string; repo?: { full_name?: string } } }
type Event = { repository?: { full_name?: string }; sender?: { login?: string }; pull_request?: Pull; merge_group?: { head_ref?: string } }

// Who this run is about: the pull_request event, or in the merge queue the PR its ref names (gh-readonly-queue/<base>/pr-<N>-<sha>), read from GitHub.
function whoIs(): Who | null {
  let ev: Event
  try { ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8')) as Event } catch { return null }
  const repo = ev.repository?.full_name ?? ''
  let pr = ev.pull_request
  const queued = /\/pr-(\d+)-[0-9a-f]+$/.exec(ev.merge_group?.head_ref ?? '')?.[1]
  if (!pr && queued) { try { pr = ghPages(`repos/${repo}/pulls/${queued}`)[0] as Pull } catch { return null } }
  if (!pr?.number || !pr.head?.sha || !repo) return null
  return { number: pr.number, author: (pr.user?.login ?? '').toLowerCase(), sender: (ev.sender?.login ?? '').toLowerCase(), repo, headSha: pr.head.sha, sameRepo: pr.head.repo?.full_name === repo }
}

// The latest non-comment review per person; true when someone other than the author approved this head commit.
function approvedBySomeoneElse(reviews: { user?: { login?: string }; state?: string; commit_id?: string; author_association?: string }[], author: string, sha: string): boolean {
  const latest = new Map<string, (typeof reviews)[number]>()
  for (const r of reviews) if (r.user?.login && r.state !== 'COMMENTED') latest.set(r.user.login, r)
  return [...latest].some(([login, r]) => login.toLowerCase() !== author && r.state === 'APPROVED' && r.commit_id === sha && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(r.author_association ?? ''))
}

// Why a tier-0 PR still needs a person ('' when it does not). `ref` is the live base tip, so lowering the rung or a new revert counts at once.
function tierZeroRefusal(ref: string, config: Registry, who: Who | null): string {
  let rung: unknown = 0
  try { rung = (JSON.parse(showAt(ref, '.rig/autonomy.json') ?? '{}') as { rung?: unknown }).rung ?? 0 } catch { /* unreadable: rung 0 */ }
  if (rung !== 3) return `rung ${String(rung)}, not 3`
  if (!who) return 'could not read the pull request from GitHub'
  if (!who.sameRepo) return 'a fork PR never merges without a person'
  if (!config.humanApproval.trusted.includes(who.author)) return 'author not trusted'
  if (!config.humanApproval.trusted.includes(who.sender)) return `${who.sender || 'an unknown user'} (who triggered this run) is not trusted`
  let runs: { name?: string; conclusion?: string; head_sha?: string }[]
  try { runs = ghPages(`repos/${who.repo}/commits/${who.headSha}/check-runs?check_name=ai-review&per_page=100`).flatMap(p => (p as { check_runs?: typeof runs }).check_runs ?? []) } catch { return 'could not confirm ai-review (the job needs checks: read and GH_TOKEN)' }
  if (!runs.some(r => r.name === 'ai-review' && r.conclusion === 'success' && r.head_sha === who.headSha)) return `ai-review has not passed on ${who.headSha.slice(0, 7)}`
  let labelled: number[]
  try { labelled = ghPages(`search/issues?q=repo:${who.repo}+is:pr+is:merged+label:revert&per_page=100`).flatMap(p => (p as { items?: { number?: number }[] }).items ?? []).map(i => Number(i.number)).filter(Number.isFinite) } catch { return 'could not list revert-labelled PRs' }
  return breaker(changeHistory(ROOT, labelled, ref, true), config.risk.window, config.risk.maxRevertRate) ?? ''
}

function independentApproval(selfApprovers: string[], workflowEdited: boolean): string | null {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath || !fs.existsSync(eventPath)) return 'cannot verify a reviewer outside a GitHub pull_request run'
  const who = whoIs()
  if (!who) return 'the pull_request event is unreadable or has no number, repository or head commit'
  let reviews: Parameters<typeof approvedBySomeoneElse>[0]
  try { reviews = ghPages(`repos/${who.repo}/pulls/${who.number}/reviews?per_page=100`) as typeof reviews } catch { return 'could not read the PR reviews (the job needs pull-requests: read and GH_TOKEN)' }
  // a pull_request checkout is a merge commit (head is its 2nd parent); a workflow re-run reuses an old event
  if (![git(['rev-parse', 'HEAD']), git(['rev-parse', 'HEAD^2'])].includes(who.headSha)) return `the event's head ${who.headSha.slice(0, 7)} is not the checked-out commit (a re-run on a stale event?)`
  if (approvedBySomeoneElse(reviews, who.author, who.headSha)) return null
  const none = `no approving review of ${who.headSha.slice(0, 7)} from someone other than ${who.author || 'the author'}`
  if (!who.author || !selfApprovers.includes(who.author)) return none
  if (workflowEdited) return `${none}; this PR edits .github/workflows, which the lead override will not judge (the workflow is read from the PR)`
  const refused = leadOverride(ghPages, who.repo, who.headSha, selfApprovers)
  return refused === null ? null : `${none}; ${refused}`
}

// null when this workflow run's ai-review and lead-override jobs both succeeded on the head commit; otherwise why the override does not apply.
function leadOverride(gh: (route: string) => unknown[], repo: string, sha: string, selfApprovers: string[]): string | null {
  const run = process.env.GITHUB_RUN_ID
  if (!run) return 'the lead override needs GITHUB_RUN_ID (a rig-check workflow run)'
  let jobs: { name?: string; conclusion?: string; head_sha?: string }[]
  try { jobs = gh(`repos/${repo}/actions/runs/${run}/jobs?per_page=100`).flatMap(p => (p as { jobs?: typeof jobs }).jobs ?? []) } catch { return 'could not read this run\'s jobs (the job needs actions: read and GH_TOKEN)' }
  const passed = (name: string): boolean => jobs.some(j => j.name === name && j.conclusion === 'success' && j.head_sha === sha)
  const missing = ['ai-review', 'lead-override'].filter(n => !passed(n))
  if (!missing.length) {
    // the click itself: GitHub records who approved which Environment for this run; an unprotected Environment has no such record
    let approvals: { state?: string; user?: { login?: string }; environments?: { name?: string }[] }[]
    try { approvals = gh(`repos/${repo}/actions/runs/${run}/approvals`) as typeof approvals } catch { return 'could not read this run\'s environment approvals (the job needs actions: read and GH_TOKEN)' }
    if (!approvals.some(a => a.state === 'approved' && selfApprovers.includes((a.user?.login ?? '').toLowerCase()) && (a.environments ?? []).some(e => e.name === 'rig-lead-override'))) return 'the rig-lead-override Environment has no approval by a listed self-approver (give it a required reviewer)'
  }
  return missing.length ? `the lead override needs the "${missing.join('" and "')}" job to succeed on ${sha.slice(0, 7)} (label the PR rig-lead-override, then approve the rig-lead-override environment)` : null
}

function report(point: string, result: CheckResult, count: number, json: boolean, humanRows: string[] = [], inert: Inert[] = [], risk: Risk | null = null): void {
  if (json) return out(JSON.stringify({ ...result, humanRows, inert, risk }))
  // A commit hook and the CI log are read by a person, so they list each warning with its fix, not just a count.
  const text = [formatFindings(result.findings), ...(point === 'commit' || point === 'ci' ? warnLines(result.findings) : [])].filter(Boolean).join('\n')
  const idle = inert.length && point !== 'stop' ? `not configured (passing checks nothing): ${inert.map(i => `${i.id} (${i.reason})`).join('; ')}` : ''
  const human = humanRows.length ? `needs human review: ${humanRows.length} waiver/approval row(s) added by this PR\n${humanRows.map(r => `  - ${r}`).join('\n')}` : ''
  const tier = risk ? `risk: ${formatRisk(risk).replace(/^tier: /, 'tier ')}` : ''
  out([text || `sdlc check ${point}: pass (${count} file(s) checked${result.waived ? `, ${result.waived} waived` : ''})`, human, tier].filter(Boolean).join('\n'))
  if (idle) out(idle)
  const summary = process.env.GITHUB_STEP_SUMMARY
  // Backticks in a file name or message must not close the summary's code fence.
  const fenced = (t: string): string => '```\n' + t.replace(/`/g, "'") + '\n```'
  if (summary) fs.appendFileSync(summary, `## sdlc check (${point})\n\n${text ? fenced(text) : 'pass'}\n${human ? '\n' + fenced(human) + '\n' : ''}${tier ? '\n' + fenced(tier) + '\n' : ''}`)
}

export function cmdCheck(args: Args): void {
  const at = optString(args, 'at')
  if (at !== 'stop' && at !== 'commit' && at !== 'ship' && at !== 'ci') fail('usage: check --at stop|commit|ship|ci [--base <ref>] [--config-from <ref>] [--slug <s>] [--budget-ms <n>] [--json]')
  const { registry: config, rules, errors } = loadConfig(optString(args, 'config-from') ?? null)
  const baseRef = optString(args, 'base')
  const base = baseRef ? git(['merge-base', 'HEAD', baseRef]) : defaultBase()
  if (at === 'ci' && !base) fail('check --at ci needs --base <ref> with a merge-base (fetch with fetch-depth: 0)')
  let diffs: FileDiff[]
  let before: (f: string) => string
  let after: ((f: string) => string) | undefined
  let replaying = false
  if (at === 'commit') {
    diffs = stagedDiff()
    if (!diffs.length) return out('sdlc check commit: nothing staged')
    // A merge or rebase replays commits: the sensors still judge them, but the fast commands are left to CI.
    // Read from git state only (an environment variable is the model's to set).
    const marker = (p: string): boolean => { const f = git(['rev-parse', '--git-path', p]); return f !== null && exists(path.resolve(ROOT, f)) }
    replaying = marker('rebase-merge/head-name') || marker('rebase-apply/rebasing') || git(['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}']) !== null
    if (replaying) out('sdlc check commit: merge/rebase in progress, fast commands skipped; CI judges the result')
    before = f => showAt('HEAD', f) ?? ''
    after = f => showStaged(f) ?? ''
    if (git(['diff', '--name-only'])) process.stderr.write('rig: the fast commands run against your working tree, which has unstaged changes\n')
  } else if (at === 'stop') {
    const snap = readBaseline() ?? snapshot()
    if (!snap) return out('sdlc check stop: nothing to compare against (no commits yet)')
    diffs = turnDiff(snap)
    before = f => showAt(snap.sha, f) ?? ''
  } else {
    diffs = branchDiff(base ?? 'HEAD')
    before = f => showAt(base ?? 'HEAD', f) ?? ''
  }
  const slugArg = optString(args, 'slug')
  if (slugArg) checkSlug(slugArg)
  const slugs = slugArg ? [slugArg] : at === 'ci' ? slugsIn(diffs) : [activeSlug()].filter((s): s is string => Boolean(s))
  const budgetMs = Number(optString(args, 'budget-ms') ?? BUDGET_MS[at])
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) fail('--budget-ms must be a positive number')
  // A merge queue run re-checks the sensors on main with the change applied; the PR's approvals were judged on the PR itself.
  const queued = process.env.GITHUB_EVENT_NAME === 'merge_group'
  const humanRows = at === 'ci' && base && !queued ? humanRowsAdded(base) : []
  // The tier comes from the base config; the Access rows are the base's and the head's together, so a PR cannot drop a row to lower it.
  const risk = at === 'ci' && base ? riskOf(diffs, slugs, config, [...parseAccess(showAt(base, ARCH_REL) ?? ''), ...parseAccess(read(path.join(ROOT, ARCH_REL)))], true) : null
  const enforced = Boolean(risk && config.risk.enforce && !queued)
  const live = baseRef ?? base ?? 'HEAD' // the base tip, not the merge base: a rung lowered or a revert made since the PR branched counts
  const refusal = enforced && !humanRows.length && risk?.tier === 0 ? tierZeroRefusal(live, config, whoIs()) : null // '': tier 0 merges without a person
  // The merge queue: approvals were judged on the PR, but the unattended path depends on the rung and the breaker, which move. Re-check it here.
  const queueWho = queued && risk && config.risk.enforce ? whoIs() : null
  let queueRefusal = ''
  if (queued && risk && config.risk.enforce) {
    let reviews: Parameters<typeof approvedBySomeoneElse>[0] = []
    try { if (queueWho) reviews = ghPages(`repos/${queueWho.repo}/pulls/${queueWho.number}/reviews?per_page=100`) as typeof reviews } catch { /* none read: the tier-0 path decides */ }
    const person = queueWho && (approvedBySomeoneElse(reviews, queueWho.author, queueWho.headSha) || config.humanApproval.selfApprovers.includes(queueWho.author))
    if (!person) queueRefusal = risk.tier === 0 ? tierZeroRefusal(live, config, queueWho) : `tier ${risk.tier} and no approval of its head commit`
  }
  const why = humanRows.length || (enforced && refusal !== '') ? independentApproval(config.humanApproval.selfApprovers, Boolean((git(['diff', '--name-only', base ?? 'HEAD', 'HEAD', '--', '.github/workflows']) ?? '').trim())) : null // before runChecks: the PR's test commands could rewrite the event file or shadow gh
  const result = runChecks({ point: at, diffs, config, rules, slugs, commands: replaying ? 'none' : at === 'stop' ? 'fast' : 'full', budgetMs, before, after, base, ratchet: !optString(args, 'config-from') && at !== 'commit', ratchetWrite: optString(args, 'config-from') ? null : at === 'commit' ? 'stage' : 'write', contracts: at === 'commit' ? !replaying : undefined, gates: config.gates })
  // At commit, like at push, a sensor out of time warns: CI runs it again, and a hanging tool must not hold git commit hostage.
  if (at === 'commit') for (const f of result.findings) if (f.outOfTime) f.severity = 'warn'
  result.blocks = result.findings.filter(f => f.severity === 'block')
  const configFindings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file; see the sdlc README for its format' }))
  const queueFindings: Finding[] = queueRefusal ? [{ sensor: 'human-approval', severity: 'block', message: `merge queue: this PR needs a person: ${queueRefusal}`, fix: 'someone other than the author approves the PR\'s head commit, then queue it again' }] : []
  const humanFindings: Finding[] = why ? [{ sensor: 'human-approval', severity: 'block', message: humanRows.length ? `this PR adds ${humanRows.length} approval/waiver row(s): ${why}` : `risk.enforce: this PR is tier ${risk?.tier} and needs a person: ${refusal ? `${refusal}; ` : ''}${why}`, fix: humanRows.length ? 'a code owner other than the PR author reviews the rows below and approves the current head commit; pushing again needs a fresh approval' : 'someone other than the PR author approves the current head commit; pushing again needs a fresh approval' }] : []
  const syncBlocks = (at === 'commit' || at === 'ci') && declaresRegistry() ? syncFindings(config, [], 'block') : [] // config errors already block above
  const all = { ...result, findings: [...queueFindings, ...humanFindings, ...configFindings, ...syncBlocks, ...result.findings], blocks: [...queueFindings, ...humanFindings, ...configFindings, ...syncBlocks.filter(f => f.severity === 'block'), ...result.blocks] }
  report(at, all, diffs.length, Boolean(args.opt.json), humanRows, inertSensors(config, rules.length, draftApps()), risk && refusal === '' ? { ...risk, reasons: ['tier 0: merges without a person (rung 3, trusted author)'] } : risk)
  process.exitCode = all.blocks.length ? 1 : 0
}

export function cmdCheckFile(args: Args): void {
  const arg = args.pos[0]
  if (!arg || !exists(SDLC)) fail('usage: check-file <path> [--json]  (in an sdlc repo)')
  const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, arg)))
  const findings = editFindings(rel)
  if (args.opt.json) return out(JSON.stringify(findings))
  out(formatFindings(findings) || `${rel}: ok`)
}

