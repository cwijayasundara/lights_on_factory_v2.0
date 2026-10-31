// The sensor registry (behavioural harness spec 2026-10-16 §3): one .rig/sensors.json, language-free.
// A sensor is a command or a built-in, a cadence, a blocks flag and one guide sentence. Tool commands live in templates/stacks/.
import { skillRef } from './core.ts'
import { isObject, isStringList, posInt, SENSOR_NAMES } from './model.ts'

export type Cadence = 'edit' | 'turn' | 'commit' | 'ci' | 'nightly'
const CADENCES: Cadence[] = ['edit', 'turn', 'commit', 'ci', 'nightly']
export type Mode = 'continuous' | 'final'
export const BUILTIN_IDS = ['secrets', 'test-tamper', 'suppression', 'harness-tamper', 'size', 'layering', 'rules', 'red-proof', 'traceability', 'model-role'] as const
type BuiltinId = typeof BUILTIN_IDS[number]
// Harness finding names that are not built-ins: a command sensor with one of these ids would inherit that finding's gate rules.
// Derived from SENSOR_NAMES so a new harness finding is reserved the day it is added.
const RESERVED_IDS: readonly string[] = [...new Set(['commands', 'plan-gate', 'human-approval', 'sync', ...SENSOR_NAMES.filter(n => !(BUILTIN_IDS as readonly string[]).includes(n))])]
export const ALWAYS_ON: BuiltinId[] = ['secrets', 'harness-tamper']

export type RegistrySensor = { id: string; cmd?: string; builtin?: true; cadence: Cadence; blocks: boolean; guide: string; timeoutMs?: number; enabled: boolean; options?: Record<string, unknown>; ratchet?: 'down' | 'up' }
export type Paths = { tests: string[]; testSupport: string[]; fixtures: string[]; ignore: string[] }
// The risk tier's knobs (proposal 2026-10-27 B1, B2): paths that always want a person, the diff size above which a person looks, and whether rig-check requires the approval.
export type Risk = { enforce: boolean; alwaysHuman: string[]; maxLines: number; window: number; maxRevertRate: number }
export type Contracts = { files: string[]; covers: string[]; validate: string; run: string }
type Policy = Record<string, Mode> & { default: Mode }
export type Registry = { ratchets?: Record<string, number>; stack: string | null; gates: { plan: boolean }; humanApproval: { selfApprovers: string[]; trusted: string[] }; risk: Risk; contracts: Contracts; models: { build: string; evaluate: string; design: string }; paths: Paths; sensors: RegistrySensor[]; knownRed: string[]; policy: Policy }

type Base = { cadence: Cadence; blocks: boolean; guide: string }
const BUILTIN_DEFAULTS: Record<BuiltinId, Base> = {
  'secrets': { cadence: 'edit', blocks: true, guide: 'Never write credentials into the repo; read them from the environment.' },
  'test-tamper': { cadence: 'edit', blocks: true, guide: 'Fix the code, never the test: do not skip, delete or weaken tests or lower coverage thresholds.' },
  'suppression': { cadence: 'edit', blocks: true, guide: 'Do not silence a lint or type error without a reason on the same line.' },
  'harness-tamper': { cadence: 'edit', blocks: true, guide: 'Do not weaken .rig/sensors.json, .rig/rules.json or frozen contract files; ask a person to waive instead.' },
  'size': { cadence: 'turn', blocks: false, guide: 'Keep files, diffs and lines under the size limits; the size finding names each file and line over the limit, so fix those rather than searching for them.' },
  'layering': { cadence: 'edit', blocks: true, guide: 'Respect the declared layer rules; do not import across a forbidden boundary.' },
  'rules': { cadence: 'edit', blocks: true, guide: 'Follow the project rules in .rig/rules.json.' },
  'red-proof': { cadence: 'commit', blocks: true, guide: 'A new test must fail before the change and pass after it.' },
  'traceability': { cadence: 'commit', blocks: true, guide: 'Every behaviour in the change spec.md needs a test that names its B-number; brief behaviours with no test yet only warn.' },
  'model-role': { cadence: 'turn', blocks: false, guide: `Build on the build model; leave diff review to the ${skillRef('pr')} reviewer; the evaluator agent reviews charts, plans and test plans.` },
}
const GENERIC_TESTS = ['**/test/**', '**/tests/**', '**/__tests__/**']
const DEFAULT_POLICY: Policy = { haiku: 'continuous', sonnet: 'continuous', opus: 'final', default: 'continuous' }
const SENSOR_KEYS = ['id', 'cmd', 'builtin', 'cadence', 'blocks', 'count', 'guide', 'timeoutMs', 'enabled', 'options', 'ratchet']
const TOP_KEYS = ['stack', 'gates', 'humanApproval', 'risk', 'contracts', 'models', 'paths', 'sensors', 'policy', 'knownRed']
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const isBuiltinId = (v: string): v is BuiltinId => (BUILTIN_IDS as readonly string[]).includes(v)
const isCadence = (v: unknown): v is Cadence => typeof v === 'string' && (CADENCES as string[]).includes(v)
const isMode = (v: unknown): v is Mode => v === 'continuous' || v === 'final'

function builtinSensor(id: BuiltinId): RegistrySensor {
  return { id, builtin: true, ...BUILTIN_DEFAULTS[id], enabled: true }
}

export function defaultRegistry(): Registry {
  return {
    stack: null,
    gates: { plan: true },
    humanApproval: { selfApprovers: [], trusted: [] },
    risk: { enforce: false, alwaysHuman: [], maxLines: 400, window: 20, maxRevertRate: 0.1 },
    contracts: { files: [], covers: [], validate: '', run: '' },
    models: { build: 'sonnet', evaluate: 'opus', design: 'sonnet' },
    paths: { tests: [...GENERIC_TESTS], testSupport: [], fixtures: [], ignore: ['**/*.md', '**/*.lock'] },
    sensors: BUILTIN_IDS.map(builtinSensor),
    knownRed: [],
    policy: { ...DEFAULT_POLICY },
  }
}

function parseSensor(raw: unknown, at: string, errors: string[]): RegistrySensor | null {
  if (!isObject(raw)) { errors.push(`${at} must be an object`); return null }
  const before = errors.length
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!KEBAB.test(id)) errors.push(`${at}.id must be kebab-case`)
  if ('builtin' in raw && raw.builtin !== true) errors.push(`${at}.builtin must be true when present`)
  const builtin = raw.builtin === true
  if (builtin && id && !isBuiltinId(id)) errors.push(`${at}: "${id}" is not a built-in sensor (known: ${BUILTIN_IDS.join(', ')})`)
  if (!builtin && isBuiltinId(id)) errors.push(`${at}: "${id}" is a built-in id; add "builtin": true or rename the sensor`)
  if (!builtin && RESERVED_IDS.includes(id)) errors.push(`${at}: "${id}" is reserved for a harness finding; rename the sensor`)
  if (builtin && 'cmd' in raw) errors.push(`${at}: a built-in sensor has no cmd`)
  if (!builtin && (typeof raw.cmd !== 'string' || !raw.cmd.trim())) errors.push(`${at}.cmd must be a non-empty command string`)
  const base = builtin && isBuiltinId(id) ? BUILTIN_DEFAULTS[id] : null
  const cadence = raw.cadence ?? base?.cadence
  if (!isCadence(cadence)) errors.push(`${at}.cadence must be one of ${CADENCES.join(', ')}`)
  const blocks = raw.blocks ?? base?.blocks
  if (typeof blocks !== 'boolean') errors.push(`${at}.blocks must be true or false`)
  const guide = raw.guide ?? base?.guide
  if (typeof guide !== 'string' || !guide.trim()) errors.push(`${at}.guide must be a non-empty sentence`)
  if ('timeoutMs' in raw && !posInt(raw.timeoutMs)) errors.push(`${at}.timeoutMs must be a positive integer`)
  const enabled = raw.enabled ?? true
  if (typeof enabled !== 'boolean') errors.push(`${at}.enabled must be true or false`)
  if (enabled === false && (ALWAYS_ON as string[]).includes(id)) errors.push(`${at}: ${id} cannot be disabled`)
  if (blocks === false && (ALWAYS_ON as string[]).includes(id)) errors.push(`${at}: ${id} must block`)
  if ('ratchet' in raw && (builtin || (raw.ratchet !== 'down' && raw.ratchet !== 'up'))) errors.push(`${at}.ratchet must be "down" or "up" on a command sensor (its last output line is the number)`)
  if ('options' in raw && !builtin) errors.push(`${at}: only built-in sensors take options`)
  else if ('options' in raw && !isObject(raw.options)) errors.push(`${at}.options must be an object`)
  const opts = isObject(raw.options) ? raw.options : {}
  if (id === 'layering' && 'layers' in opts && !(Array.isArray(opts.layers) && opts.layers.every(l => isObject(l) && typeof l.from === 'string' && isStringList(l.mustNotImport) && typeof l.why === 'string'))) errors.push(`${at}.options.layers must be a list of { from, mustNotImport: [...], why }`)
  if (id === 'size') for (const [k, v] of Object.entries(opts)) if (!['fileLines', 'diffLines', 'lineChars'].includes(k) || !posInt(v)) errors.push(`${at}.options.${k} must be one of fileLines, diffLines, lineChars with a positive integer`)
  for (const k of Object.keys(raw)) if (!SENSOR_KEYS.includes(k)) errors.push(`${at}: unknown key "${k}"`)
  if (errors.length !== before) return null
  const timeout = raw.timeoutMs
  const options = raw.options
  const common = { cadence: cadence as Cadence, blocks: blocks as boolean, guide: (guide as string).trim(), enabled: enabled as boolean, ...(posInt(timeout) ? { timeoutMs: timeout } : {}) }
  if (builtin) return { id, builtin: true, ...common, ...(isObject(options) ? { options } : {}) }
  return { id, cmd: raw.cmd as string, ...common, ...(raw.ratchet === 'down' || raw.ratchet === 'up' ? { ratchet: raw.ratchet } : {}) }
}

function parseSensors(raw: unknown, errors: string[]): RegistrySensor[] {
  if (!Array.isArray(raw)) { errors.push('sensors must be a list'); return BUILTIN_IDS.map(builtinSensor) }
  const out: RegistrySensor[] = []
  raw.forEach((r, i) => {
    const s = parseSensor(r, `sensors[${i}]`, errors)
    if (!s) return
    if (out.some(o => o.id === s.id)) errors.push(`duplicate sensor id "${s.id}"`)
    else out.push(s)
  })
  for (const id of BUILTIN_IDS) if (!out.some(s => s.id === id)) out.push(builtinSensor(id))
  return out
}

const strings = (v: unknown, at: string, errors: string[]): string | null => {
  if (typeof v === 'string') return v
  errors.push(`${at} must be a string`)
  return null
}

function parseSections(value: Record<string, unknown>, r: Registry, errors: string[]): void {
  if ('stack' in value) {
    if (typeof value.stack === 'string' && value.stack.trim()) r.stack = value.stack
    else errors.push('stack must be a non-empty string')
  }
  if ('gates' in value) {
    const g = value.gates
    if (!isObject(g)) errors.push('gates must be { plan?: boolean }')
    else for (const [k, v] of Object.entries(g)) {
      if (k === 'plan' && typeof v === 'boolean') r.gates.plan = v
      else if (k === 'merge') continue // retired, accepted and ignored
      else errors.push(`gates.${k} must be plan, true or false`)
    }
  }
  if ('humanApproval' in value) {
    const h = value.humanApproval
    if (!isObject(h)) errors.push('humanApproval must be { selfApprovers?: [GitHub logins], trusted?: [GitHub logins] }')
    else for (const [k, v] of Object.entries(h)) {
      if ((k === 'selfApprovers' || k === 'trusted') && isStringList(v)) r.humanApproval[k] = [...new Set(v.map(x => x.trim().toLowerCase()).filter(Boolean))]
      else errors.push(`humanApproval.${k} must be selfApprovers or trusted, a list of GitHub logins`)
    }
  }
  if ('risk' in value) {
    const k0 = value.risk
    if (!isObject(k0)) errors.push('risk must be { enforce?: boolean, alwaysHuman?: [globs], maxLines?: positive integer }')
    else for (const [k, v] of Object.entries(k0)) {
      if (k === 'enforce') { if (typeof v === 'boolean') r.risk.enforce = v; else errors.push('risk.enforce must be true or false') }
      else if (k === 'alwaysHuman') { if (isStringList(v)) r.risk.alwaysHuman = v; else errors.push('risk.alwaysHuman must be a list of globs') }
      else if (k === 'maxLines') { if (posInt(v)) r.risk.maxLines = v; else errors.push('risk.maxLines must be a positive integer') }
      else if (k === 'window') { if (posInt(v)) r.risk.window = v; else errors.push('risk.window must be a positive integer') }
      else if (k === 'maxRevertRate') { if (typeof v === 'number' && v >= 0 && v <= 1) r.risk.maxRevertRate = v; else errors.push('risk.maxRevertRate must be a number from 0 to 1') }
      else errors.push(`risk.${k} is not enforce, alwaysHuman, maxLines, window or maxRevertRate`)
    }
  }
  if ('contracts' in value) {
    const c = value.contracts
    if (!isObject(c)) errors.push('contracts must be { files?: [globs], covers?: [globs], validate?: string, run?: string }')
    else for (const [k, v] of Object.entries(c)) {
      if (k === 'files') { if (isStringList(v)) r.contracts.files = v; else errors.push('contracts.files must be a list of globs') }
      else if (k === 'covers') { if (isStringList(v)) r.contracts.covers = v; else errors.push('contracts.covers must be a list of globs') }
      else if (k === 'validate' || k === 'run') { const s = strings(v, `contracts.${k}`, errors); if (s !== null) r.contracts[k] = s.trim() }
      else errors.push(`contracts: unknown key "${k}"`)
    }
  }
  if ('models' in value) {
    const m = value.models
    if (!isObject(m)) errors.push('models must be { build?: string, evaluate?: string, design?: string }')
    else for (const [k, v] of Object.entries(m)) {
      if ((k === 'build' || k === 'evaluate' || k === 'design') && typeof v === 'string' && v.trim()) r.models[k] = v.trim()
      else errors.push(`models.${k} must be build, evaluate or design, a model name`)
    }
  }
  if ('paths' in value) {
    const p = value.paths
    if (!isObject(p)) errors.push('paths must be { tests?, testSupport?, fixtures?, ignore? } lists of globs')
    else for (const [k, v] of Object.entries(p)) {
      if ((k === 'tests' || k === 'testSupport' || k === 'fixtures' || k === 'ignore') && isStringList(v)) r.paths[k] = v
      else errors.push(`paths.${k} must be tests, testSupport, fixtures or ignore, a list of globs`)
    }
  }
  if ('policy' in value) {
    const p = value.policy
    if (!isObject(p)) errors.push('policy must map model families to "continuous" or "final"')
    else for (const [k, v] of Object.entries(p)) {
      if (KEBAB.test(k) && isMode(v)) r.policy[k] = v
      else errors.push(`policy.${k} must be "continuous" or "final"`)
    }
  }
  if ('knownRed' in value) {
    if (isStringList(value.knownRed)) r.knownRed = [...new Set(value.knownRed)]
    else errors.push('knownRed must be a list of sensor ids')
  }
  if ('sensors' in value) r.sensors = parseSensors(value.sensors, errors)
}

export function parseRegistry(text: string): { registry: Registry; errors: string[] } {
  const registry = defaultRegistry()
  if (!text.trim()) return { registry, errors: [] }
  let value: unknown
  try { value = JSON.parse(text) } catch (e) { return { registry, errors: [`sensors.json does not parse: ${(e as Error).message}`] } }
  if (!isObject(value)) return { registry, errors: ['sensors.json must be a JSON object'] }
  const errors: string[] = []
  parseSections(value, registry, errors)
  for (const id of registry.knownRed) if (!registry.sensors.some(s => s.id === id && s.cmd)) errors.push(`knownRed: "${id}" is not a command sensor`)
  for (const k of Object.keys(value)) if (!TOP_KEYS.includes(k)) errors.push(`unknown key "${k}"`)
  return { registry, errors }
}

// ---------- policy and selection (spec §3.3) ----------

// The longest policy key found in the model id wins, so a family named "sonnet-fast" beats "sonnet".
export function modelFamily(model: string | null | undefined, policy: Policy): string {
  const id = (model ?? '').toLowerCase()
  if (!id) return 'default'
  const keys = Object.keys(policy).filter(k => k !== 'default').sort((a, b) => b.length - a.length)
  return keys.find(k => id.includes(k)) ?? 'default'
}

export const policyMode = (r: Registry, model: string | null | undefined): Mode => r.policy[modelFamily(model, r.policy)] ?? r.policy.default

const RANK: Record<Cadence, number> = { edit: 0, turn: 1, commit: 2, ci: 3, nightly: 4 }

// A sensor runs at its own cadence and every later one; a nightly sensor only at nightly; nightly runs everything enabled.
export function runsAt(s: RegistrySensor, at: Cadence): boolean {
  if (!s.enabled) return false
  if (s.cadence === 'nightly') return at === 'nightly'
  return RANK[s.cadence] <= RANK[at]
}

// Under "final", in-session cadences keep only the always-on built-ins; commit, ci and nightly run in full.
export function activeSensors(r: Registry, at: Cadence, mode: Mode): RegistrySensor[] {
  const due = r.sensors.filter(s => runsAt(s, at))
  if (mode === 'continuous' || RANK[at] >= RANK.commit) return due
  return due.filter(s => (ALWAYS_ON as string[]).includes(s.id))
}

// A leading dash would read as a flag, so such a relative path gets ./ in front before quoting.
const shq = (f: string): string => {
  const s = f.startsWith('-') ? `./${f}` : f
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

// A change's source files (no tests, no deletions) with the line numbers it added: what a diff-scoped sensor judges.
export type Changed = { file: string; lines: number[] }
const CHANGED = /\{changed(-lines)?(?::([A-Za-z0-9,]+))?\}/g
const ranges = (c: Changed): string[] => c.lines.reduce<[number, number][]>((rs, n) => { const last = rs[rs.length - 1]; if (last && n === last[1] + 1) last[1] = n; else rs.push([n, n]); return rs }, []).map(([a, b]) => `${c.file}:${a}-${b}`)

// {changed[:exts]} is the change's source files, space-separated; {changed-lines[:exts]} one argument of file:from-to ranges,
// comma-separated. No diff (null: a baseline or nightly run) or nothing of those kinds changed: skip (null).
function changedFor(cmd: string, changed: Changed[] | null): string | null {
  let empty = false
  const text = cmd.replace(CHANGED, (_, lines: string | undefined, exts: string | undefined) => {
    const picked = (changed ?? []).filter(c => !exts || exts.split(',').some(k => c.file.endsWith(`.${k}`)))
    const words = lines ? [picked.flatMap(ranges).join(',')].filter(Boolean) : picked.map(c => c.file)
    if (!words.length) empty = true
    return words.map(shq).join(' ')
  })
  return empty ? null : text
}

// null files: whole repo, so {files} becomes "." (tools that need a path still get one). An empty list with {files}: nothing to check, skip (null).
export function commandFor(s: RegistrySensor, files: string[] | null, changed: Changed[] | null = null): string | null {
  if (!s.cmd) return null
  if (s.cmd.includes('{changed')) return changedFor(s.cmd, changed)
  if (!s.cmd.includes('{files}')) return s.cmd
  if (files && !files.length) return null
  if (!files) return s.cmd.replaceAll('{files}', '.')
  return s.cmd.replaceAll('{files}', files.map(shq).join(' '))
}

export function isRegistryShape(text: string): boolean {
  try {
    const v: unknown = JSON.parse(text)
    return isObject(v) && Array.isArray(v.sensors)
  } catch { return false }
}

// Known-red sensor ids, added and removed, keeping the rest of the file as it is.
export function updateKnownRed(text: string, add: string[], remove: string[]): string {
  const raw = JSON.parse(text) as Record<string, unknown>
  const drop = new Set(remove)
  const now = (isStringList(raw.knownRed) ? raw.knownRed : []).filter(k => !drop.has(k))
  for (const k of add) if (!now.includes(k)) now.push(k)
  raw.knownRed = now
  return JSON.stringify(raw, null, 2) + '\n'
}

// ---------- harness tamper for a registry (sensors.ts calls weakensRegistry) ----------

const LIMIT_DEFAULTS: Record<string, number> = { fileLines: 400, diffLines: 500, lineChars: 160 }

// What an edit loosens: a sensor removed, disabled, made advisory, re-commanded or moved later; wider ignores; fewer
// test globs; new known red; a family moved to "final"; raised size limits; lost contract files or commands; a gate off.
export function weakensRegistry(beforeText: string, afterText: string): string[] {
  const now = parseRegistry(afterText)
  if (now.errors.some(e => /does not parse|must be a JSON object/.test(e))) return ['sensors.json no longer parses']
  const b = parseRegistry(beforeText).registry
  const a = now.registry
  const out: string[] = []
  for (const s of b.sensors) {
    const n = a.sensors.find(x => x.id === s.id)
    if (!n) { out.push(`sensor ${s.id} removed`); continue }
    if (s.enabled && !n.enabled) out.push(`sensor ${s.id} disabled`)
    if (s.blocks && !n.blocks) out.push(`sensor ${s.id} no longer blocks`)
    if ((s.cmd ?? '') !== (n.cmd ?? '')) out.push(`sensor ${s.id} command changed`)
    if (s.ratchet && s.ratchet !== n.ratchet) out.push(`sensor ${s.id} ${n.ratchet ? `ratchet turned from ${s.ratchet} to ${n.ratchet}` : 'no longer ratchets'}`)
    if (n.timeoutMs !== undefined && (s.timeoutMs === undefined || n.timeoutMs > s.timeoutMs)) out.push(`sensor ${s.id} timeoutMs raised${s.timeoutMs === undefined ? '' : ` ${s.timeoutMs} → ${n.timeoutMs}`}`)
    if (RANK[n.cadence] > RANK[s.cadence]) out.push(`sensor ${s.id} moved from ${s.cadence} to ${n.cadence}`)
    if (s.id === 'size') for (const k of Object.keys(LIMIT_DEFAULTS)) {
      const from = Number(s.options?.[k] ?? LIMIT_DEFAULTS[k]), to = Number(n.options?.[k] ?? LIMIT_DEFAULTS[k])
      if (to > from) out.push(`size.${k} raised ${from} → ${to}`)
    } else if (s.builtin && JSON.stringify(s.options ?? {}) !== JSON.stringify(n.options ?? {})) out.push(`sensor ${s.id} options changed`)
  }
  for (const k of ['ignore', 'fixtures', 'testSupport'] as const) for (const g of a.paths[k]) if (!b.paths[k].includes(g)) out.push(`paths.${k} added ${g}`)
  for (const g of b.paths.tests) if (!a.paths.tests.includes(g)) out.push(`paths.tests lost ${g}`)
  for (const id of a.knownRed) if (!b.knownRed.includes(id)) out.push(`knownRed added ${id}`)
  for (const fam of new Set([...Object.keys(b.policy), ...Object.keys(a.policy)])) {
    if ((a.policy[fam] ?? a.policy.default) === 'final' && (b.policy[fam] ?? b.policy.default) === 'continuous') out.push(`policy.${fam} moved to final`)
  }
  for (const g of b.contracts.files) if (!a.contracts.files.includes(g)) out.push(`contracts.files lost ${g}`)
  for (const g of b.contracts.covers) if (!a.contracts.covers.includes(g)) out.push(`contracts.covers lost ${g}`)
  for (const k of ['validate', 'run'] as const) if (b.contracts[k] && a.contracts[k] !== b.contracts[k]) out.push(`contracts.${k} changed`)
  if (b.gates.plan && !a.gates.plan) out.push('gates.plan turned off')
  for (const u of a.humanApproval.selfApprovers) if (!b.humanApproval.selfApprovers.includes(u)) out.push(`humanApproval.selfApprovers added ${u}`)
  if (b.risk.enforce && !a.risk.enforce) out.push('risk.enforce turned off')
  for (const g of b.risk.alwaysHuman) if (!a.risk.alwaysHuman.includes(g)) out.push(`risk.alwaysHuman lost ${g}`)
  if (a.risk.maxLines > b.risk.maxLines) out.push('risk.maxLines raised')
  if (a.risk.window > b.risk.window) out.push('risk.window raised')
  if (a.risk.maxRevertRate > b.risk.maxRevertRate) out.push('risk.maxRevertRate raised')
  for (const u of a.humanApproval.trusted) if (!b.humanApproval.trusted.includes(u)) out.push(`humanApproval.trusted added ${u}`)
  return out
}

// The contract files, as the freeze sees them: commands with no files declared default to .rig/contracts/**.
export const contractGlobs = (c: Contracts): string[] => (c.files.length ? c.files : c.validate || c.run ? ['.rig/contracts/**'] : [])
export const builtinOptions = (r: Registry, id: BuiltinId): Record<string, unknown> => r.sensors.find(s => s.builtin && s.id === id)?.options ?? {}

// A sensor that passes only because nothing configures it must not read as a green check: status and check list these.
export type Inert = { id: string; reason: string }
export function inertSensors(r: Registry, ruleCount: number, extra: Inert[] = []): Inert[] {
  const on = (id: BuiltinId) => r.sensors.some(s => s.builtin && s.id === id && s.enabled)
  const layers = builtinOptions(r, 'layering').layers
  const unit = String(builtinOptions(r, 'red-proof').sensor ?? 'unit')
  return [
    ...(on('layering') && !(Array.isArray(layers) && layers.length) ? [{ id: 'layering', reason: 'no layers declared in .rig/sensors.json (options.layers)' }] : []),
    ...(on('rules') && !ruleCount ? [{ id: 'rules', reason: 'no rules in .rig/rules.json' }] : []),
    ...(on('red-proof') && !r.sensors.some(s => s.id === unit && s.cmd && s.enabled) ? [{ id: 'red-proof', reason: `no "${unit}" command sensor to run new tests on the base` }] : []),
    ...extra,
  ]
}
