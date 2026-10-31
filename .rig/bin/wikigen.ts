// Wiki page writing and claim review (wiki design 2026-10-17): the only model-facing code. Every call goes through a Runner, so the
// logic around it (validate, rewrite once, review, drop, regenerate once) is tested with a scripted one.
import { spawnSync } from 'node:child_process'
import { cleanClaudeEnv } from './model.ts'
import { findSymbol, parseCites, type Cite } from './wikicite.ts'
import { bodyLines, validatePage, type PageEnv, type WikiFinding } from './wikivalidate.ts'
import { parseWikiConfig, type WikiConfig, type WikiPage } from './wikistate.ts'

export type Runner = (req: { role: 'plan' | 'write' | 'review'; prompt: string }) => { text: string; usd: number }
type Verdict = 'supported' | 'unsupported' | 'contradicted'
type Verdicts = { line: number; verdict: Verdict }[]

const WIKI_MODEL = 'claude-sonnet-5-5'
// Sonnet 5.5 list prices, dollars per million tokens (claude-api skill table, cached 2026-10-06).
const PRICE_PER_MTOK = { input: 2, output: 10 }
const MAX_PLAN_FILES = 400

// Pre-flight figure: each page's sources are read by the writer and again by the reviewer; a page is about 1.8k tokens out.
export function estimateUsd(pages: number, sourceChars: number): number {
  const inTok = (sourceChars / 4) * 2 + pages * 2000
  const outTok = pages * 1800
  return (inTok * PRICE_PER_MTOK.input + outTok * PRICE_PER_MTOK.output) / 1e6
}

// The real runner: a one-shot `claude -p` (prompt on stdin: sources can exceed an argv element) with no tools (the prompt carries the sources) and user settings only, so a target repo's
// CLAUDE.md, hooks and plugins add nothing (measured 2026-10-17: $0.06 a call with them, $0.0005 without). Cost comes from its JSON result.
export function claudeRunner(model: string = WIKI_MODEL): Runner {
  return ({ prompt }) => {
    const bin = process.env.RIG_CLAUDE || 'claude'
    const env = cleanClaudeEnv()
    const c = spawnSync(bin, ['-p', '--output-format', 'json', '--model', model, '--tools', '', '--setting-sources', 'user', '--disable-slash-commands', '--no-session-persistence'], { input: prompt, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 })
    if ((c.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error(`${bin} not found: install Claude Code`)
    if (c.error) throw new Error(`${bin} did not finish: ${c.error.message}`)
    if (c.status !== 0) throw new Error(`${bin} exited ${c.status}: ${(c.stderr ?? '').trim().split('\n').slice(-2).join(' ')}`)
    let j: { result?: unknown; total_cost_usd?: unknown; is_error?: unknown }
    try { j = JSON.parse(c.stdout) } catch { throw new Error(`${bin} printed no JSON result`) }
    if (j.is_error || typeof j.result !== 'string') throw new Error(`${bin} returned an error result`)
    return { text: j.result, usd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0 }
  }
}

const unfence = (t: string): string => /^```[\w-]*\n([\s\S]*)\n```\s*$/.exec(t.trim())?.[1] ?? t
const jsonSpan = (t: string, open: string, close: string): string | null => {
  const a = t.indexOf(open)
  const b = t.lastIndexOf(close)
  return a >= 0 && b > a ? t.slice(a, b + 1) : null
}

export function planConfig(files: string[], run: Runner): { config: WikiConfig | string; usd: number } {
  const shown = files.slice(0, MAX_PLAN_FILES)
  const r = run({ role: 'plan', prompt: [
    'Propose a wiki plan for this codebase as JSON only: {"pages": [{"title", "purpose", "paths", "parent"?}]}.',
    'At most 30 pages. Titles are unique. Group by module or flow, not by file. "parent" must be another page title.',
    '"paths" lists the repo-relative files or directory prefixes (ending in /) that page is built from; give every page paths.',
    `Tracked source files${files.length > shown.length ? ` (first ${shown.length} of ${files.length})` : ''}:`, ...shown,
  ].join('\n') })
  const json = jsonSpan(r.text, '{', '}')
  return { config: json === null ? 'the planner returned no JSON' : parseWikiConfig(json), usd: r.usd }
}

const RULES = [
  'Write a Markdown wiki page for engineers. Format rules, checked by a script:',
  '- One sentence per line. Every body line ends with a citation. Headings and the first `> purpose` line are the only exceptions.',
  '- Citations are `[path#symbol]` for a function, class or constant, `[path#Class.method]` for a method, or `[path]` for a whole file. Cite only the files supplied. No line ranges.',
  '- State what the code does. Give a reason ("why") only with `[adr:NNNN]`, `[commit:<sha>]` or `[pr:<number>]` that you were given.',
  '- Include one ```mermaid diagram if it helps; every diagram line ends with `%% [path#symbol]`.',
].join('\n')

const fenced = (sources: Record<string, string>): string => Object.entries(sources).map(([p, t]) => `### ${p}\n\`\`\`\n${t}\n\`\`\``).join('\n\n')

function writePage(page: WikiPage, sources: Record<string, string>, run: Runner, hint?: string): { text: string; usd: number } {
  const r = run({ role: 'write', prompt: [
    RULES, '', `Page title: ${page.title}`, `Purpose (use as the first \`> \` line): ${page.purpose}`,
    ...(page.notes?.length ? ['Notes from the team:', ...page.notes.map(n => `- ${n}`)] : []),
    ...(hint ? ['', 'Your previous attempt had these problems; fix them:', hint] : []), '', 'Sources:', fenced(sources),
  ].join('\n') })
  return { text: unfence(r.text).replace(/\r\n/g, '\n').replace(/\s*$/, '\n'), usd: r.usd }
}

// The code a citation points at, for the reviewer to read beside the claim.
function cited(c: Cite, sources: Record<string, string>): string {
  if (c.kind === 'why') return `(${c.type}:${c.ref})`
  const file = sources[c.path]
  if (file === undefined) return `(${c.path}: not supplied)`
  return c.symbol === undefined ? file : (findSymbol(file, c.symbol, c.path) ?? `(${c.path}#${c.symbol}: not found)`)
}

export function reviewPage(text: string, sources: Record<string, string>, run: Runner): { verdicts: Verdicts; usd: number; error?: string } {
  const claims = bodyLines(text)
  if (!claims.length) return { verdicts: [], usd: 0 }
  const code = new Map<string, string>()
  const items = claims.map(b => {
    const keys = parseCites(b.text).map(c => {
      const key = c.kind === 'why' ? `${c.type}:${c.ref}` : c.symbol === undefined ? c.path : `${c.path}#${c.symbol}`
      if (!code.has(key)) code.set(key, cited(c, sources))
      return key
    })
    return `${b.line}: ${b.text}  -> see ${keys.join(', ')}`
  })
  const r = run({ role: 'review', prompt: [
    'For each numbered claim, judge only from the cited code below: "supported" (the code shows it), "unsupported" (the code does not show it)',
    'or "contradicted" (the code shows otherwise). Reply with a JSON array only: [{"line": N, "verdict": "supported"}, ...].',
    '', 'Claims:', ...items, '', 'Cited code:', ...[...code].map(([k, v]) => `### ${k}\n${v}`),
  ].join('\n') })
  const json = jsonSpan(r.text, '[', ']')
  let arr: unknown
  try { arr = json === null ? null : JSON.parse(json) } catch { arr = null }
  if (!Array.isArray(arr)) return { verdicts: [], usd: r.usd, error: 'could not read the reviewer reply as a JSON array' }
  const said = new Map<number, Verdict>()
  for (const v of arr) {
    const o = v as { line?: unknown; verdict?: unknown }
    if (typeof o?.line === 'number' && (o.verdict === 'supported' || o.verdict === 'unsupported' || o.verdict === 'contradicted')) said.set(o.line, o.verdict)
  }
  // A claim the reviewer did not mention is not vouched for: it counts as unsupported.
  return { verdicts: claims.map(b => ({ line: b.line, verdict: said.get(b.line) ?? 'unsupported' })), usd: r.usd }
}

export function dropClaims(text: string, verdicts: Verdicts): { text: string; dropped: number; total: number; removed: string[] } {
  const bad = new Set(verdicts.filter(v => v.verdict !== 'supported').map(v => v.line))
  const lines = text.split('\n')
  const removed = lines.filter((_, i) => bad.has(i + 1))
  return { text: lines.filter((_, i) => !bad.has(i + 1)).join('\n'), dropped: removed.length, total: verdicts.length, removed }
}

type BuildResult = { text: string | null; findings: WikiFinding[]; dropped: number; usd: number; error?: string }
type Attempt = BuildResult & { total: number; removed: string[] }

export function buildPage(args: { page: WikiPage; sources: Record<string, string>; env: PageEnv; run: Runner; hint?: string }): BuildResult {
  const { page, sources, env, run } = args
  const once = (hint?: string): Attempt => {
    let w = writePage(page, sources, run, hint)
    let usd = w.usd
    const check = (text: string): WikiFinding[] => [...validatePage(text, env), ...(bodyLines(text).length ? [] : [{ rule: 'uncited' as const, line: 0, message: 'the page has no cited claims; write lines that end in a citation' }])]
    let findings = check(w.text)
    if (findings.length) {
      w = writePage(page, sources, run, [hint, ...findings.map(f => `line ${f.line}: ${f.message}${w.text.split('\n')[f.line - 1] ? ` -> ${w.text.split('\n')[f.line - 1]}` : ''}`)].filter(Boolean).join('\n'))
      usd += w.usd
      findings = check(w.text)
      if (findings.length) return { text: null, findings, dropped: 0, usd, total: 0, removed: [] }
    }
    const rv = reviewPage(w.text, sources, run)
    usd += rv.usd
    if (rv.error) return { text: null, findings: [], dropped: 0, usd, total: 0, removed: [], error: rv.error }
    const d = dropClaims(w.text, rv.verdicts)
    return { text: d.text, findings: [], dropped: d.dropped, usd, total: d.total, removed: d.removed }
  }
  const over = (a: Attempt): boolean => a.total > 0 && a.dropped / a.total > 0.3
  let r = once(args.hint)
  if (r.text !== null && over(r)) {
    const second = once([args.hint, `The reviewer could not support these lines, so write them from the code or leave them out:\n${r.removed.join('\n')}`].filter(Boolean).join('\n'))
    r = { ...second, usd: r.usd + second.usd }
    if (r.text !== null && over(second)) r.findings = [{ rule: 'unsupported', line: 0, message: `${second.dropped} of ${second.total} claims were not supported after a regeneration` }]
  }
  if (r.text !== null && !bodyLines(r.text).length) r = { ...r, text: null, findings: [{ rule: 'unsupported', line: 0, message: 'no claim survived the review' }] }
  const { total: _t, removed: _r, ...out } = r
  return out
}
