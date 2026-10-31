// The PRD format for coding agents (spec 2026-10-26 PRD format and conversion): every rule a numbered, testable line, so the
// requirements ledger can be generated from it and nothing rides on prose. Pure over text; no repo, no model.
import { normalise, prdBlocks, prdLines, cells, unquoted, prdIds, type ChartFinding } from './chartcheck.ts'

export type Criterion = { id: string; parent: string | null; kind: 'rule' | 'answer' | 'out-of-scope'; line: number; text: string; when?: string; by?: string; reason?: string }
// `(out of scope: <when>, decided by <who> — <reason>)` on a criterion: kept in the PRD and the ledger, owed no behaviour or test.
const OUT_OF_SCOPE = /\s*\(out of scope:\s*(.*?),\s*decided by\s+(.*?)\s+[—–-]+\s*(.*?)\)\s*/i

// The template's sections, in order; the strict ones must be present (Data rules, NFRs and Boundaries may hold `none`).
const PRD_SECTIONS = ['Context and problem', 'Goals and success metrics', 'Non-goals', 'Users and scenarios', 'Functional requirements', 'Data rules',
  'Non-functional requirements', 'Examples', 'Boundaries', 'Integrations and constraints', 'Decisions', 'Open questions']
const REQUIRED = ['Functional requirements', 'Data rules', 'Non-functional requirements', 'Boundaries', 'Open questions']
const FR_LINE = /^\s*(?:[-*]\s+)?(?:\*\*)?(?:Need|Priority|Depends on)(?:\*\*)?\s*:/i
const CRITERION = /^\s*[-*]\s+(?:\*\*)?(AC-(\d+)\.\d+|DR-\d+)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.*)$/
const SHAPE = (t: string): boolean => /\b(?:when|if)\b[\s\S]*\bshall\b/i.test(t) || /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i.test(t)
const NFR_ROW = /^\s*\|\s*(NFR-\d+)\s*\|/

type Line = { n: number; text: string; h2: string; fr: string | null }
// The `##` headings outside comments and fences: a section hidden in either does not count.
// Lines of the PRD body with their 1-based number, the `##` section and the `### FR-n` they sit under. Comments are blanked
// line for line and fenced blocks dropped, so numbers stay those of prd.md.
function lines(prd: string, heads: string[] = []): Line[] {
  const { lines: all, start } = prdLines(prd)
  const out: Line[] = []
  let h2 = ''
  let fr: string | null = null
  let fence = ''
  for (let i = start; i < all.length; i++) {
    const l = all[i]!
    const f = /^\s*(```|~~~)/.exec(l)?.[1]
    if (fence) { if (f === fence) fence = ''; continue }
    if (f) { fence = f; continue }
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(l)
    if (h && h[1]!.length <= 2) { h2 = h[1] === '##' ? h[2]! : ''; if (h[1] === '##') heads.push(h2); fr = null; continue }
    if (h && h[1] === '###') { fr = /^(FR-\d+)\b/.exec(h[2]!)?.[1] ?? null; if (fr) continue }
    out.push({ n: i + 1, text: l, h2, fr })
  }
  return out
}

// Each criterion with its continuation lines (indented, not a new bullet) joined into one text.
function criteria(ls: Line[]): (Criterion & { shaped: boolean; fr: string | null; num: string | null })[] {
  const out: (Criterion & { shaped: boolean; fr: string | null; num: string | null })[] = []
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]!
    if (l.h2 === 'Non-functional requirements') {
      const m = NFR_ROW.exec(l.text)
      if (m?.[1]) out.push({ id: m[1], parent: m[1], kind: 'rule', line: l.n, text: normalise(cells(l.text).join(' | ')), shaped: true, fr: null, num: null })
      continue
    }
    const m = CRITERION.exec(l.text)
    if (!m || (l.h2 !== 'Functional requirements' && l.h2 !== 'Data rules')) continue
    const parts = [m[3] ?? '']
    while (ls[i + 1] && ls[i + 1]!.n === ls[i]!.n + 1 && /^\s+\S/.test(ls[i + 1]!.text) && !/^\s*[-*]\s/.test(ls[i + 1]!.text)) parts.push(ls[++i]!.text.trim())
    const raw = parts.join(' ').replace(/^\*\*\s*/, '')
    const oos = OUT_OF_SCOPE.exec(raw)
    const text = normalise(raw.replace(OUT_OF_SCOPE, ''))
    const id = m[1]!
    out.push({ id, parent: m[2] ? `FR-${m[2]}` : null, kind: oos ? 'out-of-scope' : /\(answered at chart\)/i.test(raw) ? 'answer' : 'rule', line: l.n, text, ...(oos ? { when: oos[1]!, by: oos[2]!, reason: oos[3]! } : {}), shaped: id.startsWith('DR-') || SHAPE(text), fr: l.fr, num: m[2] ?? null })
  }
  return out
}

export const prdCriteria = (prd: string): Criterion[] => criteria(lines(prd)).map(({ shaped: _s, fr: _f, num: _n, ...c }) => c)

export function prdFormatProblems(prd: string): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string): number => out.push({ rule, severity: 'block', where, message })
  const found: string[] = []
  const ls = lines(prd, found)
  const heads = new Set(found.map(h => h.toLowerCase()))
  const known = new Set(PRD_SECTIONS.map(s => s.toLowerCase()))
  for (const h of found) if (!known.has(h.toLowerCase())) add('prd-section', 'prd', `"## ${h}" is not a section of the template: move its rules into Functional requirements, Data rules or Non-functional requirements, and its prose into Context`)
  for (const s of REQUIRED) if (!heads.has(s.toLowerCase())) add('prd-section', 'prd', `the PRD has no "## ${s}" section${s === 'Functional requirements' || s === 'Open questions' ? '' : ' (write "none" under it when there is nothing)'}`)
  const cs = criteria(ls)
  const owned = new Set(cs.map(c => c.line))
  const continued = new Set<number>()
  for (const c of cs) for (let n = c.line + 1; ls.some(l => l.n === n && /^\s+\S/.test(l.text) && !/^\s*[-*]\s/.test(l.text)); n++) continued.add(n)
  const frs = [...new Set(ls.filter(l => l.h2 === 'Functional requirements' && l.fr).map(l => l.fr!))]
  for (const fr of frs) if (!cs.some(c => c.fr === fr && c.id.startsWith('AC-'))) add('prd-criterion', fr, `${fr} has no numbered criterion: add "- AC-${fr.slice(3)}.1: WHEN <trigger> THE SYSTEM SHALL <response>"`)
  for (const c of cs) {
    if (c.num !== null && c.fr !== `FR-${c.num}`) add('prd-criterion', `prd.md:${c.line}`, `${c.id} sits under ${c.fr ?? 'no FR'}; an AC-n.m belongs under ### FR-n`)
    if (!c.shaped) add('prd-criterion', `prd.md:${c.line}`, `${c.id} is not testable as written: use "WHEN <trigger> THE SYSTEM SHALL <response>" or "Given <state>, when <action>, then <result>" with exact values`)
    if (c.id.startsWith('NFR-') && !/\d/.test(cells(ls.find(l => l.n === c.line)!.text)[3] ?? '')) add('prd-nfr', c.id, `${c.id} has no number in its target: give a number and a unit (an absolute such as "never" or "no" is 0, quoting the source's word)`)
  }
  const seen = new Map<string, number>()
  for (const c of cs) seen.set(c.id, (seen.get(c.id) ?? 0) + 1)
  for (const [id, n] of seen) if (n > 1) add('prd-id', id, `${id} is defined ${n} times`)
  for (const l of ls) {
    if (!l.text.trim() || owned.has(l.n) || continued.has(l.n)) continue
    if (CRITERION.test(l.text) && l.h2 !== 'Functional requirements' && l.h2 !== 'Data rules') { add('prd-criterion', `prd.md:${l.n}`, `"${l.text.trim()}" sits under "## ${l.h2}": an AC belongs under its FR, a DR under Data rules`); continue }
    const strict = l.h2 === 'Functional requirements' || l.h2 === 'Data rules' || (l.h2 === 'Non-functional requirements' && !/^\s*\|/.test(l.text))
    if (!strict || FR_LINE.test(l.text) || /^none\.?$/i.test(l.text.trim())) continue
    add('prd-prose', `prd.md:${l.n}`, `a rule written as prose ("${l.text.trim()}"): make it an AC under its FR or a DR under Data rules`)
  }
  return out
}

// requirements.md generated from the criteria: the ledger line format chart check, the change copy and the PR review read.
export const prdLedger = (prd: string): string => ['# Requirements (generated from prd.md by rig: never edit)', '',
  ...prdCriteria(prd).map(c => c.kind === 'out-of-scope' ? `- ${c.id} [out-of-scope: ${c.when}, decided by ${c.by}] prd.md:${c.line} "${c.text}" — ${c.reason}` : `- ${c.id} [${c.kind}] prd.md:${c.line} "${c.text}"`), ''].join('\n')

// ---------- the conversion map: every sentence of the person's original accounted for ----------
// `- <id>[, <id>...] source.md:<line> "<quote>"` or `- context source.md:<line> "<quote>" — <reason>`.
type MapRow = { ids: string[]; context: boolean; line: number; quote: string; reason: string }
const MAP_LINE = /^\s*[-*]\s+(context|[A-Z]+-[\d.]+(?:\s*,\s*[A-Z]+-[\d.]+)*)\s+source\.md:(\d+)\s+"(.*)"(?:\s+[—–]+\s*(.*))?\s*$/
const SLACK = 3
export const parseMap = (text: string): MapRow[] => text.replace(/\r\n/g, '\n').split('\n').flatMap(l => {
  const m = MAP_LINE.exec(l)
  return m ? [{ ids: m[1] === 'context' ? [] : m[1]!.split(/\s*,\s*/), context: m[1] === 'context', line: Number(m[2]), quote: m[3] ?? '', reason: (m[4] ?? '').trim() }] : []
})
// The inner text of each fenced block: examples are copied into prd.md, never retyped.
const fences = (text: string): { line: number; body: string }[] => [...text.replace(/\r\n/g, '\n').matchAll(/^(\s*)(```|~~~)[^\n]*\n([\s\S]*?)^\s*\2\s*$/gm)]
  .map(m => ({ line: text.slice(0, m.index).split('\n').length, body: normalise(m[3] ?? '') })).filter(f => f.body)

// Why a quote is not in source.md: a fenced block or a table header (the row above |---|) is never mapped, anything else is misquoted.
const misquote = (quote: string, source: string, q = normalise(quote), ls = source.replace(/\r\n/g, '\n').split('\n'), flat = (s: string): string => s.replace(/\s+/g, ' ').trim()): string =>
  q && fences(source).some(f => f.body.split('\n').some(l => l.trim() === q.trim()) || (flat(f.body).length >= 20 && flat(q).includes(flat(f.body)))) ? `"${quote}" is inside a fenced block: a fenced block is not mapped, it is copied under ## Examples; drop this row`
    : q && ls.some((l, n) => /^\s*\|/.test(l) && /^\s*\|?\s*:?-{3,}/.test(ls[n + 1] ?? '') && normalise(cells(l).join(' | ')) === q) ? `"${quote}" is a table header: a table header is not mapped, only its body rows; drop this row`
    : `"${quote}" is not in source.md word for word`

export function conversionProblems(i: { source: string; prd: string; map: string | null }): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string): number => out.push({ rule, severity: 'block', where, message })
  if (i.map === null) { add('map-missing', 'conversion', 'conversion.md is missing: map every sentence of source.md to the prd.md id it became, or to context with a reason'); return out }
  const blocks = prdBlocks(i.source, { allSections: true })
  const rows = parseMap(i.map)
  for (const l of i.map.replace(/\r\n/g, '\n').split('\n')) if (/^\s*[-*]\s+\S/.test(l) && !MAP_LINE.test(l)) add('map-line', 'conversion', `conversion.md has a row that does not read as \`- <ids> source.md:<line> "<quote>"\`: ${l.trim()}`)
  const defined = new Set([...prdCriteria(i.prd).map(c => c.id), ...prdIds(i.prd)])
  for (const r of rows) {
    const q = normalise(r.quote)
    const near = blocks.filter(b => b.text.includes(q))
    if (!q || !near.length) add('map-misquote', `source.md:${r.line}`, misquote(r.quote, i.source))
    else if (!near.some(b => Math.abs(b.line - r.line) <= SLACK || (r.line >= b.line && r.line <= b.end))) add('map-misquote', `source.md:${r.line}`, `"${r.quote}" is at source.md:${near.map(b => b.line).join(', ')}, not ${r.line}`)
    for (const id of r.ids) if (!defined.has(id)) add('map-id', id, `conversion.md maps "${r.quote}" to ${id}, which prd.md does not define`)
    if (r.context && !r.reason) add('map-reason', `source.md:${r.line}`, `"${r.quote}" is mapped to context: add " — <why it is not a rule>"`)
  }
  const quotes = rows.map(r => normalise(r.quote))
  for (const b of blocks) for (const piece of unquoted(b.text, quotes)) add('map-unquoted', `source.md:${b.line}`, `source.md:${b.line} says "${piece}", which conversion.md does not map`)
  const target = normalise(i.prd)
  for (const f of fences(i.source)) if (!target.includes(f.body)) add('map-fence', `source.md:${f.line}`, `the fenced block at source.md:${f.line} is not in prd.md word for word: copy it under ## Examples`)
  return out
}
