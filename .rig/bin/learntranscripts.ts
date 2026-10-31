// The person's own corrections, read from this repo's Claude Code transcripts (proposal 2026-10-23 §3): a correction typed mid-session
// ("no, don't mock the DB") reaches the learning ladder even when no reviewer repeats it. Local only: the output stays under .rig/learn/
// (gitignored) and is never sent anywhere. Zero tokens; the /rig:learn skill groups paraphrases.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Correction = { text: string; session: string; date: string }

const MAX_CHARS = 400
const MIN_SESSIONS = 2
const SECRETS: [RegExp, string][] = [
  [/sk[-_](?:live_|test_)?[A-Za-z0-9_-]{16,}/g, '[redacted]'], [/AKIA[0-9A-Z]{16}/g, '[redacted]'], [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'], [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]'], [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]'],
  [/(:\/\/)[^/\s:@]+:[^@\s]+@/g, '$1[redacted]@'],
]
// A value after a secret-looking name (AWS_SECRET_ACCESS_KEY=, "password": ...): redacted when it looks like a secret, a digit in at least 6
// characters or any 12, so prose such as "the token: use the cache" is left alone.
const NAMED_SECRET = /([\w-]*(?:api[_-]?key|token|secret|passw(?:or)?d)[\w-]*["']?\s*[:=]\s*["']?)((?=[^\s"',}]*\d)[^\s"',}]{6,}|[^\s"',}]{12,})/gi
// Approvals and git commands repeat across sessions but teach nothing: they are never a repeated correction.
const NOT_A_CORRECTION = /^(?:(?:y|yes|ok|okay|sure|continue|proceed|go|ahead|please|lgtm|thanks?|thank you|done|next|do it)[\s,.!]*)+$|^(?:merge|push|commit|rebase|pull|checkout)\b/i
const BLOCKS = /<(pasted_content|system-reminder)\b[^>]*>[\s\S]*?<\/\1>/g

// Claude Code names a project's transcript folder after its path, every character outside [A-Za-z0-9] turned into `-`.
export const projectDir = (root: string, home = os.homedir()): string => path.join(home, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'))
// The path as given and its real path (macOS /var is /private/var; a repo may sit under a symlink): Claude Code may have named the folder from either.
export function projectDirs(root: string, home = os.homedir()): string[] {
  const real = ((): string => { try { return fs.realpathSync(root) } catch { return root } })()
  return [...new Set([root, real].map(r => projectDir(r, home)))]
}

export const redact = (text: string): string => SECRETS.reduce((t, [re, to]) => t.replace(re, to), text).replace(NAMED_SECRET, '$1[redacted]')

type Line = { type?: string; isMeta?: boolean; isSidechain?: boolean; toolUseResult?: unknown; origin?: { kind?: string }; sessionId?: string; timestamp?: string; message?: { content?: unknown } }

// Text of a turn the person typed, or null: a string, or text blocks only (a tool result, an image or any other block is not typed text).
function typedText(l: Line): string | null {
  if (l.type !== 'user' || l.isMeta || l.isSidechain || l.toolUseResult !== undefined) return null
  if (l.origin && l.origin.kind !== 'human') return null
  const c = l.message?.content
  const raw = typeof c === 'string' ? c : Array.isArray(c) && c.every(b => b?.type === 'text') ? c.map(b => String(b.text ?? '')).join('\n') : null
  if (raw === null || (!l.origin && raw.trimStart().startsWith('<'))) return null
  const text = raw.replace(BLOCKS, '').trim()
  return !text || text.startsWith('<') || text.startsWith('/') || text.length > MAX_CHARS ? null : redact(text)
}

export function typedTurns(jsonl: string): Correction[] {
  return jsonl.split('\n').flatMap((s): Correction[] => {
    let l: Line
    try { l = JSON.parse(s) as Line } catch { return [] }
    const text = l && typeof l === 'object' ? typedText(l) : null
    return text ? [{ text, session: (l.sessionId ?? '').slice(0, 8), date: (l.timestamp ?? '').slice(0, 10) }] : []
  })
}

// Exact repeats across sessions (case, spacing and trailing punctuation ignored); the first wording seen is kept.
export function repeated(cs: Correction[]): { text: string; sessions: string[] }[] {
  const by = new Map<string, { text: string; sessions: string[] }>()
  for (const c of cs) {
    if (NOT_A_CORRECTION.test(c.text.trim())) continue
    const key = c.text.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?\s]+$/, '')
    const g = by.get(key) ?? { text: c.text, sessions: [] }
    if (!g.sessions.includes(c.session)) g.sessions.push(c.session)
    by.set(key, g)
  }
  return [...by.values()].filter(g => g.sessions.length >= MIN_SESSIONS)
}

// The *.jsonl files directly in the folder; subagent transcripts live in subfolders and are not the person's words.
export function mineTranscripts(dir: string): Correction[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && d.name.endsWith('.jsonl')).map(d => d.name).sort()
    .flatMap(n => typedTurns(fs.readFileSync(path.join(dir, n), 'utf8')))
}
