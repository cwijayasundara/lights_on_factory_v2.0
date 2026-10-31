// The pure data model for sensors: diffs, globs, config, rules and findings. No fs or git access (the gh helpers run the gh binary).
import { execFileSync } from 'node:child_process'
import type { Paths } from './registry.ts'
export type Line = { n: number; text: string }
type FileStatus = 'A' | 'M' | 'D' | 'R'
export type FileDiff = { file: string; from?: string; status: FileStatus; added: Line[]; removed: Line[]; binary?: true; oversize?: true }
export type Severity = 'block' | 'warn'
// Every built-in and harness finding name; /rig:waive accepts these plus the registry's command sensor ids (a test keeps this in step with the sources).
export const SENSOR_NAMES = [
  'test-tamper', 'suppression', 'layering', 'size', 'secrets', 'rules', 'harness-tamper',
  'traceability', 'red-proof', 'unscanned', 'config', 'contracts', 'model-role', 'journeys', 'scope',
]

// The environment for an inner `claude`: none of the outer Claude Code session (its id, port, effort, entrypoint, messaging) or the test
// runner's context, so it starts as a teammate's would. Credentials and provider switches stay, so a live run still authenticates.
const KEEP_CLAUDE = /^CLAUDE_CODE_(?:OAUTH_TOKEN|USE_[A-Z]+|SKIP_[A-Z_]+_AUTH)$/
export const cleanClaudeEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !['CLAUDECODE', 'CLAUDE_EFFORT', 'NODE_TEST_CONTEXT'].includes(k) && (!k.startsWith('CLAUDE_CODE_') || KEEP_CLAUDE.test(k))))

export type Finding = { sensor: string; severity: Severity; file?: string; line?: number; message: string; fix: string; labels?: string[]; outOfTime?: true }
export type Layer = { from: string; mustNotImport: string[]; why: string; example?: string }
export type Rule = { id: string; pattern: string; paths?: string[]; message: string; why: string; action: Severity }

export const SECRET_PATTERNS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe live key', /\b[rs]k_live_[0-9A-Za-z]{16,}\b/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Azure storage key', /AccountKey=[A-Za-z0-9+/]{40,}={0,2}/],
  ['env-style secret', /^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)\s*=\s*[^\s"'$`<{(][^\s"']{15,}\s*$/m],
  ['generic secret assignment', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{12,}["']/i],
]

// A private key spans lines: after its BEGIN line, mask every line through the matching END line (or to the end).
export function maskSecrets(text: string): string {
  let inKey = false
  return text.split('\n').map(l => {
    if (inKey) {
      inKey = !/-----END [A-Z ]*PRIVATE KEY-----/.test(l)
      return '[masked by sdlc]'
    }
    if (!SECRET_PATTERNS.some(([, re]) => re.test(l))) return l
    inKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(l)
    return '[masked by sdlc]'
  }).join('\n')
}

// The body under `## <heading>`, up to the next `## ` heading or the end.
export const section = (text: string, heading: string): string =>
  new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm').exec(text)?.[1] ?? ''

// The paths a section lists: a bullet is split on commas and spaces and every path-like token counts (a / or a short extension, after an
// optional "Create:"-style label, punctuation stripped; e.g. and i.e. do not), so prose ("No existing test ...") is skipped; over-matching is
// caught by approve --check. A backticked token leading its comma segment counts as written. A non-bullet line counts only when its first
// token is a path and nothing but a parenthesis or a dash follows it.
const isPathLike = (t: string): boolean => /\/|\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(t) && !/^(e\.g|i\.e|etc)$/i.test(t)
const bulletPaths = (body: string): string[] => body.split('\n').flatMap(l => {
  const b = /^\s*[-*]\s+(.*)$/.exec(l)
  if (!b) { const m = /^\s*(?:`([^`\s]+)`|([^`\s]+))(.*)$/.exec(l), t = m?.[1] ?? (m?.[2] ?? '').replace(/[.,;:)]+$/, ''), rest = (m?.[3] ?? '').trim(); return t && (!rest || /^(\(|—|–|- )/.test(rest)) && (m?.[1] || isPathLike(t)) ? [t] : [] }
  return (b[1] ?? '').replace(/^[A-Za-z]+:\s+/, '').split(',').flatMap(seg => seg.trim().split(/\s+/).flatMap((raw, i) => {
    const bt = /^\(?`([^`\s]+)`/.exec(raw)?.[1], t = bt ?? raw.replace(/^\(/, '').replace(/[.,;:)]+$/, '')
    return t && (bt ? i === 0 || isPathLike(t) : isPathLike(t)) ? [t] : []
  }))
})

// The files a plan says it will touch (its ## Files section), as pr.ts reads them.
export function planFiles(plan: string): string[] {
  const body = plan.split(/^## Files[ \t]*$/m)[1]?.split(/^## /m)[0] ?? ''
  return bulletPaths(body)
}

// The paths a spec allows a change to touch (its ## Blast radius section); null when the spec has no such heading.
export const blastRadius = (spec: string): string[] | null => (/^##\s+Blast radius\s*$/m.test(spec) ? bulletPaths(section(spec, 'Blast radius')) : null)

// Questions an artifact still leaves open: entries under `## Open questions` other than "none", and any
// "Q<n> ... still open / is open / unresolved" line elsewhere. Approval needs none, so a build never stalls on one.
export function openQuestions(text: string): string[] {
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  const listed = section(text, 'Open questions').split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim()).filter(l => l && !/^none\.?$/i.test(l))
  const prose = text.split('\n').filter(l => /\bQ\d+\b.*\b(?:still open|is open|unresolved)\b/i.test(l)).map(l => l.trim())
  return [...new Set([...listed, ...prose])]
}

// ---------- globs ----------

// `**/` matches zero or more whole directories, `**` anything, `*` within one path segment.
export function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?'
        i += 2
      } else {
        re += '.*'
        i++
      }
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + (glob.endsWith('/') ? '.*' : '') + '$')
}

const compiled = new Map<string, RegExp>()
export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some(g => {
    let re = compiled.get(g)
    if (!re) compiled.set(g, (re = globToRegex(g)))
    return re.test(file)
  })
}
export const isTest = (file: string, paths: Paths): boolean => matchesAny(file, paths.tests)
export const isSource = (file: string, paths: Paths): boolean =>
  !file.startsWith('.rig/') && !matchesAny(file, paths.ignore)

// ---------- unified diff ----------

const ESCAPES: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92 }

// git C-quotes paths with unusual bytes ("caf\303\251.js"); decode the octal escapes back to UTF-8.
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p
  const s = p.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? ''
    if (c !== '\\') {
      bytes.push(...new TextEncoder().encode(c))
      continue
    }
    const next = s[i + 1] ?? ''
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i + 1, i + 4), 8))
      i += 3
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0))
      i++
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

// `--- a/x` / `+++ b/x`, with git's trailing tab for names containing spaces.
function sidePath(rest: string): string | null {
  const p = unquote(rest.replace(/\t$/, ''))
  return p === '/dev/null' ? null : p.replace(/^[ab]\//, '')
}

function headerPath(raw: string): string {
  const rest = raw.slice('diff --git '.length)
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest)
  if (quoted) return unquote(`"${quoted[1] ?? ''}"`)
  const i = rest.lastIndexOf(' b/')
  return i >= 0 ? rest.slice(i + 3) : rest
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let inHunk = false
  let oldN = 0
  let newN = 0
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { file: headerPath(raw), status: 'M', added: [], removed: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      inHunk = true
      oldN = Number(hunk[1])
      newN = Number(hunk[2])
      continue
    }
    if (!inHunk) {
      if (raw.startsWith('new file mode')) cur.status = 'A'
      else if (raw.startsWith('deleted file mode')) cur.status = 'D'
      else if (raw.startsWith('rename from ')) {
        cur.status = 'R'
        cur.from = unquote(raw.slice('rename from '.length))
      } else if (raw.startsWith('rename to ')) cur.file = unquote(raw.slice('rename to '.length))
      else if (raw.startsWith('Binary files ')) cur.binary = true
      else if (raw.startsWith('--- ')) {
        const p = sidePath(raw.slice(4))
        if (p && cur.status === 'D') cur.file = p
      } else if (raw.startsWith('+++ ')) {
        const p = sidePath(raw.slice(4))
        if (p) cur.file = p
      }
      continue
    }
    if (raw.startsWith('+')) cur.added.push({ n: newN++, text: raw.slice(1) })
    else if (raw.startsWith('-')) cur.removed.push({ n: oldN++, text: raw.slice(1) })
    else if (raw.startsWith(' ')) {
      oldN++
      newN++
    }
  }
  return files
}

// ---------- config & rules ----------

type Json = Record<string, unknown>
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

export const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

function parseJson(text: string, name: string): { value: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) }
  } catch (err) {
    return { value: null, error: `${name} is not valid JSON: ${(err as Error).message}` }
  }
}

export function parseRules(text: string): { rules: Rule[]; errors: string[] } {
  if (!text.trim()) return { rules: [], errors: [] }
  const { value, error } = parseJson(text, 'rules.json')
  if (error) return { rules: [], errors: [error] }
  if (!Array.isArray(value)) return { rules: [], errors: ['rules.json must be a list of rules'] }
  const rules: Rule[] = []
  const errors: string[] = []
  value.forEach((r, i) => {
    const id = isObject(r) && typeof r.id === 'string' ? r.id : `#${i + 1}`
    if (!isObject(r) || typeof r.id !== 'string' || typeof r.message !== 'string') return errors.push(`rule ${id}: needs id and message`)
    if (typeof r.why !== 'string' || !r.why.trim()) return errors.push(`rule ${id}: needs a why (earn every rule)`)
    if (r.action !== 'warn' && r.action !== 'block') return errors.push(`rule ${id}: action must be warn or block`)
    if (typeof r.pattern !== 'string') return errors.push(`rule ${id}: needs a pattern`)
    if (r.paths !== undefined && !isStringList(r.paths)) return errors.push(`rule ${id}: paths must be a list of globs`)
    try {
      new RegExp(r.pattern)
    } catch {
      return errors.push(`rule ${id}: pattern is not a valid regular expression`)
    }
    rules.push(r as unknown as Rule)
  })
  return { rules, errors }
}

// ---------- findings ----------

// Repo-controlled text never reaches a terminal with control, bidi-override or zero-width characters in it (they could recolour, reorder or hide output).
export const printable = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
export const warnRow = (f: Finding): string => printable(`${f.sensor}${f.file ? ` ${f.file}` : ''}: ${f.message} → ${f.fix}`).replace(/\s+/g, ' ').slice(0, 200)
// The warnings a hook shows with their fix text (formatFindings counts them): five rows, then how many more.
export function warnLines(findings: Finding[], max = 5): string[] {
  const rows = [...new Set(findings.filter(f => f.severity === 'warn').map(warnRow))]
  return [...rows.slice(0, max).map(r => `  ! ${r}`), ...(rows.length > max ? [`  +${rows.length - max} more`] : [])]
}

// Silent success, verbose failure: nothing when clean; blocks first, grouped by sensor, deduplicated, capped.
export function formatFindings(findings: Finding[], max = 40): string {
  const seen = new Set<string>()
  const unique = findings.filter(f => {
    const key = `${f.sensor}|${f.file ?? ''}|${f.line ?? ''}|${f.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const blocks = unique.filter(f => f.severity === 'block')
  const warns = unique.filter(f => f.severity === 'warn')
  const rows: string[][] = []
  for (const sensor of [...new Set(blocks.map(f => f.sensor))]) {
    rows.push([`[${sensor}]`])
    for (const f of blocks.filter(b => b.sensor === sensor)) {
      const where = f.file ? `${f.file}${f.line ? ':' + f.line : ''}: ` : ''
      const labels = f.labels?.length ? ` (${f.labels.join(', ')})` : ''
      const [first = '', ...rest] = f.message.split('\n')
      rows.push([`  ✗ ${where}${first}${labels} → ${f.fix}`, ...rest].map(printable))
    }
  }
  const tail = warns.length ? [`warn: ${warns.length} (${[...new Set(warns.map(w => w.sensor))].map(s => `${s} ${warns.filter(w => w.sensor === s).length}`).join(', ')})`] : []
  const total = rows.reduce((n, r) => n + r.length, 0)
  const room = max - tail.length
  if (total <= room) return [...rows.flat(), ...tail].join('\n')
  // Cap physical lines: whole rows while they fit, then one "more" line.
  const shown: string[] = []
  for (const r of rows) {
    if (shown.length + r.length > room - 1) break
    shown.push(...r)
  }
  if (!shown.length) shown.push(...(rows[0] ?? []).slice(0, room - 1))
  return [...shown, `  … ${total - shown.length} more (run sdlc.ts check to see all)`, ...tail].join('\n')
}
// RIG_GH names the gh binary (the evals runner's RIG_CLAUDE precedent): a caller whose PATH is rebuilt by its shell (a headless agent session) can still point the harness at the gh it means.
export const bullets = (text: string): string[] => text.split('\n').map(l => l.trim()).filter(l => /^[-*]\s+\S/.test(l))
// A path as plans and radii spell it: posix slashes, no leading ./, no trailing colon.
export const normPath = (p: string): string => p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/:$/, '')
export const ghBin = (): string => process.env.RIG_GH || 'gh'
export const gh = (argv: string[], cwd?: string): string => execFileSync(ghBin(), argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
export const ghPages = (route: string): unknown[] => (JSON.parse(gh(['api', '--paginate', '--slurp', route])) as unknown[]).flat()
