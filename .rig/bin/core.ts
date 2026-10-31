// sdlc core: paths, helpers and change state shared by every script. Zero dependencies.
// Only erasable TypeScript syntax is used (no enums, namespaces or parameter properties).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { isObject, SECRET_PATTERNS, type Finding } from './model.ts'

// ---------- types ----------

type Fields = Record<string, string>

export type Args = { pos: string[]; opt: Record<string, string | true> }
export type HookInput = {
  session_id?: string
  cwd?: string
  agent_id?: string
  agent_type?: string
  source?: string
  prompt?: string; transcript_path?: string; model?: string; to_model?: string; from_model?: string; tool_use_id?: string; tool_response?: { resolvedModel?: string; model?: string }
  tool_input?: {
    command?: string
    file_path?: string
    notebook_path?: string
    content?: string
    old_string?: string
    new_string?: string
    replace_all?: boolean
    edits?: { old_string?: string; new_string?: string; replace_all?: boolean }[]
    skill?: string
    args?: string; subagent_type?: string; model?: string
  }
}

// ---------- constants ----------

export const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd()
export const SDLC = path.join(ROOT, '.rig')
export const CHANGES = path.join(SDLC, 'changes')
// sensors.json: repo-relative posix form (messages, diff paths, joined to ROOT) and absolute.
export const SENSORS_JSON = '.rig/sensors.json'
export const SENSORS_PATH = path.join(SDLC, 'sensors.json')
// Time budget in ms per check cadence.
export const BUDGET_MS = { edit: 60_000, stop: 60_000, commit: 600_000, ship: 1_800_000, ci: 1_800_000 } as const

export const SOFT_HOOK_FAILURE = 'sdlc hook error (ignored)'

// ---------- small helpers ----------

export const exists = (p: string): boolean => fs.existsSync(p)
// Line endings are normalised so CRLF checkouts on Windows parse and digest the same as on macOS.
export const read = (p: string): string => (exists(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : '')
export const lines = (text: string): number => (text ? text.split('\n').length : 0)
export const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
export const ageDays = (at: string): number => { const n = Math.floor((Date.now() - Date.parse(at)) / 86_400_000); return Number.isFinite(n) ? Math.max(0, n) : Infinity }
export const now = (): string => new Date().toISOString()
export const toPosix = (p: string): string => p.replace(/\\/g, '/')
export const out = (text: string): void => {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n')
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/
// A slug names a directory under .rig/changes: it must be a plain name of an existing change, never a path.
export function checkSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) fail(`invalid change name ${slug}`)
  if (!fs.existsSync(path.join(CHANGES, slug))) fail(`no change named ${slug}`)
  return slug
}

export function fail(message: string, code = 1): never {
  process.stderr.write(message + '\n')
  process.exit(code)
}

// A diff larger than the default 1 MB buffer must not turn into "no changes": allow 256 MB.
export function gitIn(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }).trim()
  } catch {
    return null
  }
}
export const git = (args: string[]): string | null => gitIn(ROOT, args)

const fmTidy = (s: string): string => s.trim().replace(/^["']|["']$/g, '').replace(/^(\.\/)+/, '').replace(/\/+$/, '')
const fmInline = (v: string): string[] => v.trim().replace(/\s+#.*$/, '').replace(/^\[|\]$/g, '').split(',').map(fmTidy).filter(Boolean)

// A frontmatter list in the `key: [a, b]`, `key: a` and the multi-line `key:` then `  - a` forms; frontmatter() keeps only scalars.
export function fmList(text: string, key: string): string[] {
  const rows = (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n')
  const at = rows.findIndex(r => new RegExp(`^${key}:`).test(r))
  if (at < 0) return []
  const here = fmInline(rows[at]!.slice(key.length + 1))
  if (here.length || rows[at]!.slice(key.length + 1).trim()) return here
  return rows.slice(at + 1).filter((r, i, all) => /^\s+-\s*\S/.test(r) && all.slice(0, i).every(x => /^\s+-/.test(x))).map(r => fmTidy(r.replace(/^\s+-\s*/, '').replace(/\s+#.*$/, '')))
}

export function frontmatter(text: string): { data: Fields; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { data: {}, body: text }
  const data: Fields = {}
  for (const row of (m[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(row)
    if (kv?.[1]) data[kv[1]] = (kv[2] ?? '').replace(/^["']|["']$/g, '').trim()
  }
  return { data, body: text.slice(m[0].length) }
}

// The parsed file, or the fallback when it is missing, empty or not valid JSON.
export function readJson<T>(p: string, fallback: T): T {
  try { return JSON.parse(read(p)) as T } catch { return fallback }
}

// The blocks the quality gate gave up on (written by the Stop hook); [] when absent or unreadable.
export const UNRESOLVED = path.join(SDLC, 'unresolved.json')
export const readUnresolved = (): Finding[] => readJson<{ findings?: Finding[] }>(UNRESOLVED, {}).findings ?? []

export function readJsonl<T>(p: string): T[] {
  return read(p)
    .split('\n')
    .filter(Boolean)
    .flatMap(row => {
      try {
        return [JSON.parse(row) as T]
      } catch {
        return []
      }
    })
}

export function parseArgs(argv: string[]): Args {
  const pos: string[] = []
  const opt: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true
      else {
        opt[a.slice(2)] = next
        i++
      }
    } else pos.push(a)
  }
  return { pos, opt }
}

export const optString = (args: Args, key: string): string | undefined => {
  const v = args.opt[key]
  return typeof v === 'string' ? v : undefined
}
// ---------- changes ----------

export function listChanges(root?: string): string[] {
  const dir = root === undefined ? CHANGES : path.join(root, '.rig', 'changes')
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && SLUG_RE.test(d.name))
    .map(d => d.name)
    .sort()
}

// Paths are compared in POSIX form so plans written on macOS match edits made on Windows.
export function relPosix(file: string): string {
  return toPosix(path.isAbsolute(file) ? path.relative(ROOT, file) : file)
}

export const TRUNKS = ['origin/main', 'main', 'origin/master', 'master']
export const trunkName = (): string => git(['rev-parse', '--verify', '-q', 'main']) === null && git(['rev-parse', '--verify', '-q', 'master']) !== null ? 'master' : 'main'
// Files differing from HEAD or untracked (not ignored), optionally only under `paths`. Names, never porcelain lines: git() trims its output, which shifted the status columns of every line after the first.
export function dirtyFiles(paths: string[] = []): string[] {
  const names = (args: string[]): string[] => (git([...args, ...(paths.length ? ['--', ...paths] : [])]) ?? '').split('\n').filter(Boolean)
  return [...new Set([...names(['diff', '--name-only', 'HEAD']), ...names(['ls-files', '--others', '--exclude-standard'])])]
}
export const isTrunk = (name: string): boolean => ['main', 'master'].includes(name)
export function defaultBase(): string | null {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  for (const ref of TRUNKS) {
    if (git(['rev-parse', '--verify', '--quiet', ref]) && head !== ref.replace('origin/', '')) return git(['merge-base', 'HEAD', ref])
  }
  return null
}

// ---------- secrets & plan quality ----------

export function scanSecrets(file: string): string[] {
  const text = read(file)
  if (!text || text.length > 2_000_000) return []
  const hits: string[] = []
  text.split('\n').forEach((row, i) => {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(row)) hits.push(`${file}:${i + 1}: possible ${name}`)
    }
  })
  return hits
}

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..')
// A standalone repo runs its own copy from .rig/bin: its skills and agents are registered as rig-<name>, the plugin's skills as /rig:<name>.
export const IS_VENDORED = path.basename(import.meta.dirname) === 'bin'
// A repo with the standalone skills answers to /rig-x even when the plugin's script runs there (2026-10-25 shop_app plan.md).
export const skillRef = (name: string): string => (IS_VENDORED || exists(path.join(ROOT, '.claude/skills/rig-start/SKILL.md')) ? `/rig-${name}` : `/rig:${name}`)
// Managed settings (the platform team's, which no engineer can edit): the OS file plus managed-settings.d/ drop-ins in name order.
// Objects merge, arrays concatenate, later scalars win. RIG_MANAGED_DIR overrides the directory (tests). Server-managed settings are not visible here.
const MANAGED_DIR = process.env.RIG_MANAGED_DIR || (process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
  : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code')
export function managedFiles(dir = MANAGED_DIR): string[] {
  const d = path.join(dir, 'managed-settings.d')
  let drops: string[] = []
  try { drops = fs.readdirSync(d).filter(f => f.endsWith('.json')).sort().map(f => path.join(d, f)) } catch { /* none, or unreadable */ }
  return [path.join(dir, 'managed-settings.json'), ...drops].filter(f => { try { JSON.parse(fs.readFileSync(f, 'utf8')); return true } catch { return false } })
}
const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k,
  isObject(a[k]) && isObject(b[k]) ? deepMerge(a[k], b[k]) : Array.isArray(a[k]) && Array.isArray(b[k]) ? [...a[k], ...b[k]] : k in b ? b[k] : a[k]]))
export const managedSettings = (dir = MANAGED_DIR): Record<string, unknown> =>
  managedFiles(dir).reduce<Record<string, unknown>>((acc, f) => { const v: unknown = JSON.parse(fs.readFileSync(f, 'utf8')); return isObject(v) ? deepMerge(acc, v) : acc }, {})

const GITIGNORED = [
  'state/', 'maintain/seen.json', '.baseline', '.gate', 'unresolved.json', 'gates.jsonl', 'changes/*/pr-outline.md', 'learn/',
]

// Parallel hooks (subagents) read-modify-write the same small state file: serialise them with a mkdir lock (stale after 10 s;
// after 5 s of waiting, proceed rather than wedge the hook) and write by rename so a reader never sees half a file.
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  const until = Date.now() + 5_000
  let owned = false
  while (Date.now() < until) {
    try { fs.mkdirSync(lock); owned = true; break } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { recursive: true, force: true }) } catch { /* raced */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try { return fn() } finally { if (owned) try { fs.rmdirSync(lock) } catch { /* gone */ } }
}
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, text)
  fs.renameSync(tmp, file)
}

// --max-usd <dollars>: null when not given, NaN when it is not a number of at least `min`, else the amount.
export function usdOpt(args: Args, min: number): number | null {
  const v = args.opt['max-usd']
  if (v === undefined) return null
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= min ? n : NaN
}

// The entries .rig/.gitignore lacks.
export const gitignoreMissing = (): string[] => (exists(SDLC) ? GITIGNORED.filter(f => !new Set(read(path.join(SDLC, '.gitignore')).split('\n')).has(f)) : [])
export function ensureGitignore(): void {
  const missing = gitignoreMissing()
  const ignore = path.join(SDLC, '.gitignore')
  const text = read(ignore)
  if (missing.length) fs.appendFileSync(ignore, `${text && !text.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

export const WAIVERS = path.join(SDLC, 'waivers.jsonl')
// expires: when the waiver stops applying (a row written before expiry existed has none and never lapses).
// A waiver covers only until it expires; an unreadable expiry counts as expired, and a row with none (from before expiry existed) never lapses.
export const waiverLive = (w: { expires?: string }): boolean => !w.expires || Date.parse(w.expires) > Date.now()
export type Waiver = { slug: string; sensor: string; file: string; reason: string; by: string; at: string; expires?: string }

// ---------- the turn gate (.rig/.gate) ----------

export type GateSummary = { at: string; blocks: number; warns: number; bySensor: Record<string, number>; warnRows?: string[]; shown?: boolean }
// trees: stamps of working trees on which the fast commands passed, kept across turns (the per-turn fields reset at each prompt).
export type Gate = { turn: string; blocks: Record<string, number>; passed: Record<string, string>; tool: string[]; guides: Record<string, string[]>; trees: string[]; last?: GateSummary }
export const GATE = path.join(SDLC, '.gate')
const emptyGate = (): Gate => ({ turn: '', blocks: {}, passed: {}, tool: [], guides: {}, trees: [] })

export function readGate(): Gate {
  try {
    const g = JSON.parse(read(GATE)) as Record<string, unknown>
    const d = emptyGate()
    const obj = <T>(v: unknown, dflt: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : dflt)
    return {
      turn: typeof g.turn === 'string' ? g.turn : d.turn, blocks: obj(g.blocks, d.blocks), passed: obj(g.passed, d.passed),
      tool: Array.isArray(g.tool) ? g.tool.map(String) : d.tool, guides: obj(g.guides, d.guides), trees: Array.isArray(g.trees) ? g.trees.map(String) : d.trees,
      ...(g.last && typeof g.last === 'object' ? { last: g.last as GateSummary } : {}),
    }
  } catch {
    return emptyGate()
  }
}
const writeGate = (g: Gate): void => writeAtomic(GATE, JSON.stringify(g))
export const updateGate = (fn: (g: Gate) => void): void => withLock(GATE, () => { const g = readGate(); fn(g); writeGate(g) })

// Files sdlc itself wrote this turn count as sanctioned edits for the Stop gate's harness-tamper rule.
export function sanctionWrites(rels: string[]): void {
  updateGate(g => { g.tool = [...new Set([...g.tool, ...rels.map(toPosix)])] })
}

// Who approvals, waivers and a scaffolded policy owner are recorded as: the git identity, then the OS user, except a generic account
// (root, a CI runner) that names no person.
const GENERIC_USERS = ['root', 'runner', 'administrator', 'admin', 'ubuntu', 'node', 'user', 'unknown']
export function whoami(): string | null {
  const os = process.env.USER || process.env.USERNAME || ''
  return git(['config', 'user.name']) || (GENERIC_USERS.includes(os.trim().toLowerCase()) ? null : os.trim()) || null
}

// Every approval and waiver names the person who made it. An identity-less one is refused, not recorded as "unknown": an owner is what
// lets a code owner or a later reader ask who stands behind it. --by is the person's own declaration (these commands are human-only).
export function ownerOrFail(args: Args, what: string): string {
  const given = typeof args.opt.by === 'string' ? args.opt.by.trim() : ''
  const by = given || whoami()
  if (!by || GENERIC_USERS.includes(by.toLowerCase())) fail(`${what} need an owner: set git user.name (git config user.name "<name>") or pass --by "<name>"`)
  return by
}
