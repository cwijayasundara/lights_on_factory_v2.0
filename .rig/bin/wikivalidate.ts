// Wiki page validation (wiki design 2026-10-17, "Against wrong claims" step 1): the rules a script can check, no model.
// A page body is one sentence per line and every such line ends with a citation; a mermaid line carries `%% [cite]`.
import { parseCites, citeHash, symbolSupported, type Cite } from './wikicite.ts'

export type WikiFinding = {
  rule: 'uncited' | 'two-sentences' | 'path-missing' | 'symbol-unresolved' | 'path-escapes' | 'why-unresolved' | 'mermaid' | 'unsupported'
  line: number
  message: string
}
export type PageEnv = {
  read: (p: string) => string | null
  whyExists: (c: { type: 'adr' | 'commit' | 'pr'; ref: string }) => boolean
}
type BodyLine = { line: number; text: string; mermaid: boolean }

const DIAGRAM_HEAD = /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|mindmap)\b/

// Non-blank body lines with their 1-based file line: not front matter, headings, the `> purpose` line or plain code fences.
export function bodyLines(text: string): BodyLine[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1)
    i = end < 0 ? 0 : end + 1
  }
  const out: BodyLine[] = []
  let fence: 'none' | 'plain' | 'mermaid' = 'none'
  let purposeSeen = false
  for (; i < lines.length; i++) {
    const l = lines[i]!
    const f = /^\s*```\s*(\w*)/.exec(l)
    if (f) { fence = fence === 'none' ? (f[1] === 'mermaid' ? 'mermaid' : 'plain') : 'none'; continue }
    if (!l.trim() || fence === 'plain') continue
    if (fence === 'mermaid') { if (!DIAGRAM_HEAD.test(l)) out.push({ line: i + 1, text: l, mermaid: true }); continue }
    if (/^#{1,6}\s/.test(l)) continue
    if (!purposeSeen && l.startsWith('> ')) { purposeSeen = true; continue }
    out.push({ line: i + 1, text: l, mermaid: false })
  }
  return out
}

export function pageCitations(text: string): { line: number; cite: Cite }[] {
  return bodyLines(text).flatMap(b => parseCites(b.text).map(cite => ({ line: b.line, cite })))
}

// Trailing `[...]` tokens that parseCites refused, to tell an escaping path from a plain missing citation.
const rawTail = (line: string): string[] =>
  [...(/((?:\s*\[[^\]\s]+\])+)\s*$/.exec(line)?.[1] ?? '').matchAll(/\[([^\]\s]+)\]/g)].map(m => m[1]!)
const escapes = (tok: string): boolean => !/^(adr|commit|pr):/.test(tok) && (tok.startsWith('/') || tok.split('#')[0]!.split('/').includes('..'))

const ABBREV = /(?<!\be\.g|\bi\.e|\betc|\bvs|\bcf|\bDr|\bMr|\bMrs|\bMs|\bProf|\bSt|\bNo|\b[A-Z])[.!?]["')\]]?\s+[A-Z]/
const prose = (line: string): string => line.replace(/`[^`]*`/g, 'x').replace(/\s*(\[[^\]\s]+\]\s*)+$/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')

export function validatePage(text: string, env: PageEnv): WikiFinding[] {
  const out: WikiFinding[] = []
  for (const b of bodyLines(text)) {
    const add = (rule: WikiFinding['rule'], message: string): number => out.push({ rule, line: b.line, message })
    const cites = parseCites(b.text)
    if (!cites.length) {
      const bad = rawTail(b.text).find(escapes)
      if (bad) add('path-escapes', `citation [${bad}] leaves the repository`)
      else add(b.mermaid ? 'mermaid' : 'uncited', b.mermaid ? 'diagram line has no `%% [cite]`' : 'line does not end with a citation')
      continue
    }
    if (b.mermaid && !/%%\s*(\[[^\]\s]+\]\s*)+$/.test(b.text)) add('mermaid', 'diagram citation must sit in a `%%` comment')
    if (!b.mermaid && ABBREV.test(prose(b.text))) add('two-sentences', 'one sentence per line')
    for (const c of cites) {
      if (c.kind === 'why') { if (!env.whyExists(c)) add('why-unresolved', `${c.type}:${c.ref} does not resolve`); continue }
      if (env.read(c.path) === null) add('path-missing', `${c.path} does not exist`)
      else if (c.symbol !== undefined && !symbolSupported(c.path)) add('symbol-unresolved', `${c.path}: #symbol cites are not supported for this language, cite the whole file`)
      else if (c.symbol !== undefined && citeHash(c, env.read) === null) add('symbol-unresolved', `${c.path}#${c.symbol} is absent or declared more than once`)
    }
  }
  return out
}
