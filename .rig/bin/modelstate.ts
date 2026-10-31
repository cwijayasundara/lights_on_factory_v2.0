// Which model is running (behavioural harness spec §3.4–3.5). Hooks record it here; nothing in this file calls a model.
import fs from 'node:fs'
import path from 'node:path'
import { modelFamily, type Registry } from './registry.ts'
import type { Finding } from './model.ts'
import { withLock, writeAtomic } from './core.ts'

type Launch = { session: string; id: string; agent: string; requested: string | null; resolved: string | null; at: string }
type ModelState = { sessions: Record<string, { model: string; source: string; at: string }>; launches: Launch[] }
const MAX_LAUNCHES = 50
const TAIL_BYTES = 256 * 1024
// A launched agent's role by name (`rig:architect`, `rig-evaluator`) and the model its role runs on.
const ROLES: [RegExp, 'evaluate' | 'design'][] = [[/(?:^|[:-])evaluator$/, 'evaluate'], [/(?:^|[:-])architect$/, 'design']]

export function readModelState(file: string): ModelState {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ModelState>
    return { sessions: v.sessions ?? {}, launches: Array.isArray(v.launches) ? v.launches : [] }
  } catch { return { sessions: {}, launches: [] } }
}

const save = (file: string, s: ModelState): void => writeAtomic(file, JSON.stringify(s, null, 2) + '\n')

// Parallel hooks (agent launches) share this file: every read-modify-write holds its lock.
function update(file: string, fn: (s: ModelState) => boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  withLock(file, () => { const s = readModelState(file); if (fn(s)) save(file, s) })
}

// The newest launch of each agent that has a model (resolved, else requested): what the dashboard shows.
export function latestAgents(file: string): { agent: string; model: string; at: string }[] {
  const by = new Map<string, { agent: string; model: string; at: string }>()
  for (const l of readModelState(file).launches) if (l && (l.resolved ?? l.requested)) by.set(l.agent, { agent: l.agent, model: (l.resolved ?? l.requested) as string, at: l.at })
  return [...by.values()]
}

export function recordSessionModel(file: string, session: string, model: string, source: string, at: string): void {
  if (!model.trim()) return
  update(file, s => { s.sessions[session] = { model: model.trim(), source, at }; return true })
}

export function recordLaunch(file: string, l: Launch): void {
  update(file, s => { s.launches = [...s.launches.filter(x => x.id !== l.id), l].slice(-MAX_LAUNCHES); return true })
}

export function recordResolved(file: string, id: string, resolved: string): void {
  if (!resolved.trim()) return
  update(file, s => { const l = s.launches.find(x => x.id === id); if (l) l.resolved = resolved.trim(); return Boolean(l) })
}

// The last assistant message of a Claude Code transcript (JSONL) that satisfies `want`, read from the file's tail only.
function lastAssistant<T>(transcriptPath: string | undefined, key: string, want: (m: Record<string, unknown>) => T | null, stopAtCompact = false): T | null {
  if (!transcriptPath) return null
  let text: string
  try {
    const fd = fs.openSync(transcriptPath, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const len = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      text = buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return null }
  for (const l of text.split('\n').reverse()) {
    if (stopAtCompact && l.includes('"compact_boundary"')) return null
    if (!l.includes(key)) continue
    try {
      const v = JSON.parse(l) as { type?: string; message?: Record<string, unknown> }
      const got = v.type === 'assistant' && v.message && v.message.model !== '<synthetic>' ? want(v.message) : null
      if (got !== null) return got
    } catch { /* the first line of a tail is usually cut */ }
  }
  return null
}
export const transcriptModel = (transcriptPath: string | undefined): string | null => lastAssistant(transcriptPath, '"model"', m => (typeof m.model === 'string' && m.model ? m.model : null))
// Tokens the last assistant message read: input plus cache read plus cache creation. How full the context is; a compaction resets it.
export const transcriptContext = (transcriptPath: string | undefined): number | null => lastAssistant(transcriptPath, '"usage"', m => {
  const u = m.usage as Record<string, unknown> | undefined
  return u ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((n, k) => n + (typeof u[k] === 'number' ? u[k] : 0), 0) : null
}, true)

export function pinnedModel(root: string): string | null {
  for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
    try {
      const m = (JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')) as { model?: unknown }).model
      if (typeof m === 'string' && m.trim()) return m.trim()
    } catch { /* absent or unreadable */ }
  }
  return null
}

// A /model switch record is newest; else the transcript; else a SessionStart record; else the pinned setting.
export function sessionModel(file: string, session: string | undefined, transcriptPath: string | undefined, root: string): string | null {
  const rec = session ? readModelState(file).sessions[session] : undefined
  if (rec?.source === 'switch') return rec.model
  return transcriptModel(transcriptPath) ?? rec?.model ?? pinnedModel(root)
}

export function modelRoleFindings(r: Registry, main: string | null, launches: Launch[]): Finding[] {
  const fam = (m: string): string => modelFamily(m, r.policy)
  const out: Finding[] = []
  if (main && fam(main) !== fam(r.models.build)) {
    out.push({ sensor: 'model-role', severity: 'warn', message: `the main thread runs on ${main}, but this repo builds on ${r.models.build}`, fix: `switch with /model ${r.models.build}, or change models.build in .rig/sensors.json` })
  }
  for (const l of launches) {
    const role = ROLES.find(([re]) => re.test(l.agent))?.[1]
    const got = l.resolved ?? l.requested
    if (role && got && fam(got) !== fam(r.models[role])) {
      out.push({ sensor: 'model-role', severity: 'warn', message: `${l.agent} ran on ${got}, but ${role === 'design' ? 'design' : 'evaluation'} runs on ${r.models[role]}`, fix: `launch ${l.agent} without a model override; its frontmatter pins ${r.models[role]}` })
    }
  }
  return out
}
