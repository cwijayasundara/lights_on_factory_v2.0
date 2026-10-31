// The sprint chart's trace rules (outer-loop spec 2026-10-17 §7): parse the PRD, the intents and the test cases, and report
// where the chain requirement → intent → behaviour → test case breaks. Pure over text; no repo, no model.
import path from 'node:path'
import { frontmatter, fmList, sha } from './core.ts'
import { openQuestions, section } from './model.ts'

export type Behaviour = { id: string; reqs: string[]; rules: string[]; text: string } // rules: ledger ids (FR-4.2, G-1) or AC aliases
export type Intent = {
  slug: string; sprint: number | null; prd: string[]; depends: string[]; estimateDays: number | null; kind: 'boundary' | 'internal' | null
  behaviours: Behaviour[]; contractFiles: string[]; exampleFiles: string[]; openQuestions: string[]
  failures: string[]; design: number // B-numbers under `### Failure behaviour`; `## Design` table rows
  owner: string // who builds it: a person fills it in when the sprint is allocated; empty until then
  scope: string[] // the repo files the intent writes (frontmatter `scope:`)
}
export type TestCase = { id: string; reqs: string[]; rules: string[]; intent: string; behaviour: string; level: string; data: string; access: string }
// A row of architecture.md `## Access`: who may take an action, on which interfaces. `nobody`: the cell says no role may.
export type AccessRule = { action: string; allowed: string[]; nobody: boolean; interfaces: string[]; intent: string }
export type ChartFinding = { rule: string; severity: 'block' | 'report'; where: string; message: string }

const REQ = /\bN?FR-\d+\b/g
// A requirements-ledger id (FR-4.2, NFR-1.1, G-3) or a PRD acceptance-criterion alias (AC-4.1).
const RULE_ID = /\b(?:N?FR-\d+\.\d+|G-\d+|DR-\d+|AC-\d+(?:\.\d+)*)\b/g
// The FR or NFR a ledger id belongs to: AC-4.1 and FR-4.2 to FR-4, NFR-2 (or NFR-2.1) to NFR-2; a data rule or G-n to none.
export const parentOf = (id: string): string | null => /^AC-(\d+)\./.exec(id) ? `FR-${/^AC-(\d+)\./.exec(id)![1]}` : /^(N?FR-\d+)(?:\.\d+)?$/.exec(id)?.[1] ?? null
const SPRINT_DAYS = 10
const MAX_DAYS = 2

// A frontmatter list of ids, flow or block style; brackets, quotes and a trailing `.md` are tolerated.
const listField = (text: string, key: string): string[] =>
  fmList(text, key).map(s => s.replace(/\.md$/, '')).filter(s => /^[A-Za-z0-9][\w.-]*$/.test(s))
// Template prompts are HTML comments: they are never content.
export const uncomment = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '')
// A table row's trimmed cells, outer pipes dropped.
export const cells = (l: string): string[] => l.trim().replace(/^\|+/, '').replace(/\|+$/, '').split('|').map(c => c.trim())
// Comments gone, and a `#` line inside a fence (a tree, a shell snippet) cannot end its section.
const fencedText = (raw: string): string => uncomment(raw.replace(/\r\n/g, '\n')).replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1/gm, b => b.replace(/^#/gm, '\u200b#'))
// A PRD with comments blanked line for line (numbers stay those of prd.md), split into lines, and the index its body starts at (after the frontmatter).
export function prdLines(prd: string): { lines: string[]; start: number } {
  const text = prd.replace(/\r\n/g, '\n').replace(/<!--[\s\S]*?-->/g, c => c.replace(/[^\n]/g, ''))
  const fm = /^---\n[\s\S]*?\n---\n/.exec(text)
  return { lines: text.split('\n'), start: fm ? fm[0].split('\n').length - 1 : 0 }
}
export const escapes = (p: string): boolean => path.isAbsolute(p) || p.split(/[\\/]/).includes('..')
const whole = (v: string | undefined): number | null => (/^\d{1,4}$/.test(v ?? '') ? Number(v) : null)

// Requirement ids the PRD defines: a heading `### FR-3: ...` or a table row `| NFR-2 | ...`. Ids in prose are references.
export function prdIds(text: string): string[] {
  const ids = new Set<string>()
  for (const l of uncomment(text.replace(/\r\n/g, '\n')).split('\n')) {
    const m = /^#{2,4}\s+(N?FR-\d+)\b/.exec(l) ?? /^\|\s*(N?FR-\d+)\s*\|/.exec(l)
    if (m?.[1]) ids.add(m[1])
  }
  return [...ids].sort()
}

// `- B1 (FR-3, NFR-1): text` lines under `## Behaviours`, in an intent or a change's spec.md.
function parseBehaviours(text: string): Behaviour[] {
  return section(text.replace(/\r\n/g, '\n'), 'Behaviours').split('\n').flatMap((l): Behaviour[] => {
    const m = /^\s*[-*]\s+(B\d+)\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/.exec(l)
    return m?.[1] ? [{ id: m[1], reqs: (m[2] ?? '').match(REQ) ?? [], rules: (m[2] ?? '').match(RULE_ID) ?? [], text: (m[3] ?? '').trim() }] : []
  })
}

export function parseIntent(slug: string, raw: string): Intent {
  const text = uncomment(raw.replace(/\r\n/g, '\n'))
  const { data } = frontmatter(text)
  const iface = section(text, 'Interfaces').split('\n')
  const files = (label: string): string[] => iface.flatMap(l => { const m = new RegExp(`^\\s*[-*]?\\s*${label}:\\s*(\\S+)`).exec(l); return m?.[1] ? [m[1]] : [] })
  return {
    slug, sprint: whole(data.sprint), prd: listField(text, 'prd'), depends: listField(text, 'depends'), estimateDays: whole(data.estimate_days),
    kind: data.kind === 'boundary' || data.kind === 'internal' ? data.kind : null,
    behaviours: parseBehaviours(text), contractFiles: files('Contract'), exampleFiles: files('Example'), openQuestions: openQuestions(text),
    failures: [...(section(text, 'Behaviours').split(/^###\s+Failure behaviour\s*$/m)[1] ?? '').matchAll(/^\s*[-*]\s+(B\d+)/gm)].map(m => m[1]!),
    design: Math.max(0, section(text, 'Design').split('\n').filter(l => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]*$/.test(l)).length - 1),
    owner: (data.owner ?? '').replace(/(^|\s)#.*$/, '').trim().replace(/^["']|["']$/g, ''), // a `# ...` comment is not a name
    scope: fmList(text, 'scope').map(f => f.replace(/^\.\//, '')).filter(Boolean),
  }
}

// shop_app 2026-10-27: three intents listed tests/test_ac_coverage.py. Two intents that can be built at once and write the same
// file are a merge conflict waiting for the second PR, so that blocks; when one depends on the other they are built in order and
// the later one edits what the earlier one wrote, which the person should see but may keep.
export function sharedScopeProblems(mine: Intent[], all: Intent[]): ChartFinding[] {
  const deps = new Map(all.map(i => [i.slug, i.depends]))
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    (deps.get(from) ?? []).some(d => d === to || (!seen.has(d) && (seen.add(d), reaches(d, to, seen))))
  const found: ChartFinding[] = []
  mine.forEach((a, x) => mine.slice(x + 1).forEach(b => {
    for (const f of [...new Set(a.scope)].filter(f => b.scope.includes(f))) {
      const ordered = reaches(a.slug, b.slug) || reaches(b.slug, a.slug)
      found.push(ordered
        ? { rule: 'scope-shared', severity: 'report', where: b.slug, message: `${f} is in the scope of ${a.slug} and ${b.slug}; they are built in order, so the later one edits what the earlier one wrote` }
        : { rule: 'scope-shared', severity: 'block', where: b.slug, message: `${f} is in the scope of ${a.slug} and ${b.slug}, which can be built at the same time: give the file to one intent, or make one depend on the other` })
    }
  }))
  return found
}

// `- slug: scope (ids)` lines (a `*` bullet, bold or backticked slug also read; fenced blocks skipped) under `## Intents` in the sprint design doc: the intents the design says the sprint is made of.
export const designIntents = (designDoc: string): string[] =>
  section(uncomment(designDoc.replace(/\r\n/g, '\n')).replace(/^(```|~~~)[\s\S]*?^\1/gm, ''), 'Intents').split('\n').flatMap(l => { const m = /^[-*]\s+(?:\*\*|`)?([a-z0-9]+(?:-[a-z0-9]+)*)(?:\*\*|`)?\s*:/.exec(l); return m?.[1] ? [m[1]] : [] })

// cases.md rows: | ID | Requirement | Intent | Behaviour | Level | Data | Expected | Access | (Access optional: a seven-column table still reads)
export function parseCases(text: string): TestCase[] {
  return text.replace(/\r\n/g, '\n').split('\n').map(l => l.split('|').map(c => c.trim())).filter(c => /^TC-\d+$/.test(c[1] ?? '')).map(c => ({
    id: c[1] ?? '', reqs: (c[2] ?? '').match(REQ) ?? [], rules: (c[2] ?? '').match(RULE_ID) ?? [], intent: (c[3] ?? '').replace(/\.md$/, ''), behaviour: c[4] ?? '', level: c[5] ?? '', data: c[6] || '-', access: c[8] || '-',
  }))
}

// ---------- the requirements ledger (spec 2026-10-26 PRD fidelity) ----------
// sprint-N/requirements.md quotes every in-scope sentence of the PRD copy word for word, so a dropped rule is a blocking finding
// rather than a judgement call: `- <id>[ (<alias>)] [<kind>] prd.md:<line> "<quote>"[ — <reason>]`.
type LedgerKind = 'rule' | 'context' | 'answer' | 'out-of-scope'
type LedgerRow = { id: string; alias: string | null; kind: LedgerKind; when: string; by: string; line: number; quote: string; reason: string }
type LedgerLine = LedgerRow | { bad: string } | { unknownKind: string; row: LedgerRow }

// Sections that hold motivation, not requirements; every other section, including ones the person invented, is in scope.
const OUT_OF_SCOPE_SECTIONS = ['context and problem', 'goals and success metrics', 'risks and assumptions', 'changes since last sprint', 'open questions']
const LEDGER_LINE = /^\s*[-*]\s+((?:N?FR-\d+\.\d+)|G-\d+|AC-\d+\.\d+|DR-\d+|NFR-\d+)(?:\s+\(([^)]+)\))?\s+\[([^\]]+)\]\s+prd\.md:(\d+)\s+"(.*)"(?:\s+[—–]+\s*(.*))?\s*$/
const LINE_SLACK = 3

// Markup and spacing never decide whether a quote matches: emphasis, backticks, curly quotes, spaces around table pipes and the
// "(answered at chart)" marker are dropped on both sides.
export const normalise = (s: string): string => s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\*\*|__|[*`]/g, '')
  .replace(/\(answered at chart\)/gi, '').replace(/\s*\(out of scope:[^)]*\)/gi, '').replace(/\s*\|\s*/g, ' | ').replace(/\s+/g, ' ').trim()

function readLedgerLine(l: string): LedgerLine | null {
  if (!/^\s*[-*]\s+\S/.test(l)) return null
  const m = LEDGER_LINE.exec(l)
  if (!m) return { bad: l.trim() }
  const kind = (m[3] ?? '').trim()
  const row: LedgerRow = { id: m[1]!, alias: m[2]?.trim() || null, kind: 'rule', when: '', by: '', line: Number(m[4]), quote: m[5] ?? '', reason: (m[6] ?? '').trim() }
  if (kind === 'rule' || kind === 'context' || kind === 'answer') return { ...row, kind }
  const oos = /^out-of-scope(?::\s*(.*?))?(?:,\s*decided by\s+(.+))?$/.exec(kind)
  return oos ? { ...row, kind: 'out-of-scope', when: (oos[1] ?? '').trim(), by: (oos[2] ?? '').trim() } : { unknownKind: kind, row }
}
const ledgerLines = (text: string): LedgerLine[] => uncomment(text.replace(/\r\n/g, '\n')).split('\n').flatMap(l => { const r = readLedgerLine(l); return r ? [r] : [] })
export const parseLedger = (text: string): LedgerRow[] => ledgerLines(text).flatMap(r => ('id' in r ? [r] : 'row' in r ? [r.row] : []))

// The PRD's in-scope blocks with their first line and last line (`end`): a bullet (with its indented continuation lines), a paragraph, or a table body
// row (cells joined by " | "). Headings, frontmatter, HTML comments, fenced blocks and table headers are never units; comments
// are blanked line for line so the numbers stay those of prd.md.
// `allSections`: a person's original PRD, where every section counts (the conversion map accounts for all of it).
export function prdBlocks(prd: string, o: { allSections?: boolean } = {}): { line: number; end: number; text: string }[] {
  const { lines, start } = prdLines(prd)
  const out: { line: number; text: string; end: number }[] = []
  let i = start
  let excluded = false
  const isSep = (l: string | undefined): boolean => /^\s*\|[\s|:-]+\|?\s*$/.test(l ?? '') && /-/.test(l ?? '')
  const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/
  while (i < lines.length) {
    const l = lines[i]!
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { if (h[1] === '##') excluded = !o.allSections && OUT_OF_SCOPE_SECTIONS.includes(h[2]!.trim().toLowerCase()); i++; continue }
    if (/^\s*(```|~~~)/.test(l)) { const fence = /^\s*(```|~~~)/.exec(l)![1]!; i++; while (i < lines.length && !lines[i]!.trim().startsWith(fence)) i++; i++; continue }
    if (!l.trim()) { i++; continue }
    const start = i
    let body: string
    if (/^\s*\|/.test(l)) {
      i++
      if (isSep(l) || isSep(lines[i])) continue
      body = cells(l).join(' | ')
    } else if (bullet.test(l)) {
      const parts = [l.replace(bullet, '')]
      i++
      while (i < lines.length && lines[i]!.trim() && /^\s+/.test(lines[i]!) && !bullet.test(lines[i]!)) parts.push(lines[i++]!.trim())
      body = parts.join(' ')
    } else {
      const parts = [l]
      i++
      while (i < lines.length && lines[i]!.trim() && !/^#{1,6}\s/.test(lines[i]!) && !bullet.test(lines[i]!) && !/^\s*(\||```|~~~)/.test(lines[i]!)) parts.push(lines[i++]!.trim())
      body = parts.join(' ')
    }
    if (!excluded && normalise(body)) out.push({ line: start + 1, text: normalise(body), end: i })
  }
  return out
}

// What a block still says once every quote is cut out of it: pieces of two or more words are text no row quotes.
export function unquoted(block: string, quotes: string[]): string[] {
  let rest = block
  for (const q of [...quotes].sort((a, b) => b.length - a.length)) if (q) rest = rest.split(q).join('\u0000')
  // A lone word counts when it is the rule itself: a number, a negation or a quantifier ("is 10", "must not", "never").
  const load = (p: string): boolean => /\d/.test(p) || /^(?:not|no|never|only|every|all|unique|none|without|must|cannot)$/i.test(p)
  return rest.split('\u0000').map(p => p.trim().replace(/^[\s.,;:!?)\]-]+|[\s.,;:!?(\[-]+$/g, '')).filter(p => { const words = p.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w)); return words.length >= 2 || (words.length === 1 && load(words[0]!)) })
}

// `required`: the sprint is not approved yet, so a missing ledger blocks; an approved sprint charted before the ledger is reported.
// `inFormat`: the PRD passed the format check, so every rule is a numbered criterion and the prose around them needs no quote.
export function ledgerProblems(i: { prd: string; ledger: string | null; intents: Intent[]; cases: TestCase[] | null; required: boolean; inFormat?: boolean }): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string, severity: 'block' | 'report' = 'block'): number => out.push({ rule, severity, where, message })
  const units = prdBlocks(i.prd)
  if (i.ledger === null) {
    if (units.length) add('ledger-missing', 'ledger', 'requirements.md is missing: quote every in-scope PRD sentence in it, one row each, before the intents cite them', i.required ? 'block' : 'report')
    return out
  }
  const lines = ledgerLines(i.ledger)
  const rows = parseLedger(i.ledger)
  for (const l of lines) {
    if ('bad' in l) add('ledger-line', 'ledger', `requirements.md has a row that does not read as \`- <id> [<kind>] prd.md:<line> "<quote>"\`: ${l.bad}`)
    if ('unknownKind' in l) add('ledger-reason', l.row.id, `${l.row.id} has the kind "${l.unknownKind}"; use rule, context, answer or out-of-scope: <when>, decided by <who>`)
  }
  for (const r of rows) {
    const q = normalise(r.quote)
    const near = units.filter(u => u.text.includes(q))
    if (!q || !near.length) add('ledger-misquote', r.id, `${r.id} quotes "${r.quote}", which is not in prd.md word for word`)
    else if (!near.some(u => Math.abs(u.line - r.line) <= LINE_SLACK || (r.line >= u.line && r.line <= u.end))) add('ledger-misquote', r.id, `${r.id} says prd.md:${r.line}, but the quote is at line ${near.map(u => u.line).join(', ')}`)
    if (r.kind === 'context' && !r.reason) add('ledger-reason', r.id, `${r.id} is context: add " — <why a test could not assert it>"`)
    if (r.kind === 'out-of-scope' && (!r.reason || !r.by)) add('ledger-reason', r.id, `${r.id} is out of scope: it needs "decided by <who>" in its kind and " — <reason>"`)
  }
  const quotes = rows.map(r => normalise(r.quote))
  if (!i.inFormat) for (const u of units) for (const piece of unquoted(u.text, quotes)) add('ledger-unquoted', `prd.md:${u.line}`, `prd.md:${u.line} says "${piece}", which no requirements.md row quotes`)
  const known = new Set(rows.flatMap(r => [r.id, ...(r.alias ? [r.alias] : [])]))
  const behaviours = i.intents.flatMap(t => t.behaviours.map(b => ({ where: `${t.slug}#${b.id}`, rules: b.rules, reqs: b.reqs })))
  for (const b of behaviours) for (const id of b.rules) if (!known.has(id)) add('unknown-id', b.where, `${b.where} cites ${id}, which requirements.md does not define`)
  const cites = (r: LedgerRow, ids: string[]): boolean => ids.includes(r.id) || (r.alias !== null && ids.includes(r.alias))
  const needed = rows.filter(r => r.kind === 'rule' || r.kind === 'answer')
  const cited = behaviours.flatMap(b => [...b.rules, ...b.reqs])
  for (const r of needed) if (!cites(r, cited)) add('rule-uncovered', r.id, `${r.id} ("${r.quote}") has no behaviour: cite it in the intent that builds it, e.g. \`- B2 (FR-4, ${r.id}): ...\``)
  if (i.cases) {
    for (const c of i.cases) for (const id of c.rules) if (!known.has(id)) add('unknown-id', c.id, `${c.id} cites ${id}, which requirements.md does not define`)
    const tested = i.cases.flatMap(c => [...c.rules, ...c.reqs])
    for (const r of needed) if (!cites(r, tested)) add('rule-untested', r.id, `${r.id} ("${r.quote}") has no test case citing it`)
  }
  return out
}

// ---------- the chart review at approval (spec 2026-10-26 PRD fidelity) ----------
// A `- ` bullet under `## Findings` of chart-review.md, numbered from 1. Only the confirm pass closes one (`→ fixed (confirmed)`);
// a bare `→ fixed` is the coordinator's own claim, and a person's waiver pins the finding's text, so a rewritten finding is open again.
export type ReviewFinding = { n: number; text: string; sha: string; status: 'confirmed' | 'reopened' | 'claimed' | 'open' }
export type ChartWaiver = { finding: number; text_sha: string; by: string; at: string; reason: string }
const SUFFIX = /\s*→\s*(fixed \(confirmed\)|reopened:.*|fixed)\s*$/
export function parseReview(text: string): ReviewFinding[] {
  return section(text.replace(/\r\n/g, '\n'), 'Findings').split('\n').filter(l => /^[-*]\s+\S|^\d+[.)]\s+\S/.test(l)).map((l, i) => {
    const m = SUFFIX.exec(l)
    const status = !m ? 'open' : m[1] === 'fixed' ? 'claimed' : m[1]!.startsWith('reopened') ? 'reopened' : 'confirmed'
    const text = l.replace(SUFFIX, '').replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()
    return { n: i + 1, text, sha: sha(normalise(text)), status }
  })
}
export const openFindings = (review: ReviewFinding[], waivers: ChartWaiver[]): ReviewFinding[] =>
  review.filter(f => f.status !== 'confirmed' && !waivers.some(w => w.finding === f.n && w.text_sha === f.sha))

// Slugs on a dependency cycle (a self-dependency is one), found by asking whether each can reach itself.
function cyclic(intents: Intent[]): Set<string> {
  const deps = new Map(intents.map(i => [i.slug, i.depends]))
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean =>
    (deps.get(from) ?? []).some(d => d === target || (!seen.has(d) && (seen.add(d), reaches(d, target, seen))))
  return new Set(intents.filter(i => reaches(i.slug, i.slug)).map(i => i.slug))
}

// `others` are the intents of other sprints (a dependency may name one; their test cases are theirs to check); `exists` resolves a case's
// data path under the test plan, `repoExists` a contract or example path in the repo.
export function traceReport(i: { prd: string; intents: Intent[]; others?: Intent[]; cases: TestCase[] | null; exists: (path: string) => boolean; repoExists?: (path: string) => boolean }): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string, severity: 'block' | 'report' = 'block'): number => out.push({ rule, severity, where, message })
  const prd = uncomment(i.prd.replace(/\r\n/g, '\n'))
  const others = i.others ?? []
  const repoExists = i.repoExists ?? ((): boolean => true)
  const defined = new Set(prdIds(prd))
  const slugs = new Set([...i.intents, ...others].map(t => t.slug))
  const cycle = cyclic([...i.intents, ...others])
  for (const q of openQuestions(prd)) add('open-question', 'prd', `the PRD has an open question: ${q}`)
  for (const t of i.intents) {
    const untraced = t.behaviours.filter(b => !b.reqs.length).map(b => b.id) // name them: `(AC-4.1)` alone blocked shop_app with no hint
    const gaps = [!t.prd.length && 'its `prd:` frontmatter is empty', !t.behaviours.length && 'it has no `- B<n> (FR-n): ...` behaviours', untraced.length && `${untraced.join(', ')} cite no requirement`].filter(Boolean)
    if (gaps.length) add('intent-untraced', t.slug, `${t.slug}: ${gaps.join('; ')}. Cite an FR-n or NFR-n id in the parentheses, e.g. \`- B1 (FR-4, AC-4.1): ...\`; an acceptance-criterion id alone does not count`)
    const cited = [...t.prd, ...t.behaviours.flatMap(b => b.reqs)]
    for (const id of new Set(cited)) if (!defined.has(id)) add('unknown-id', t.slug, `${t.slug} cites ${id}, which the PRD does not define`)
    if (t.estimateDays === null || t.estimateDays > MAX_DAYS || t.estimateDays < 1) add('estimate', t.slug, `${t.slug} needs estimate_days of 1 or ${MAX_DAYS} (split anything larger)`)
    if (t.kind === 'boundary' && !t.failures.length) add('failure-behaviour', t.slug, `${t.slug} is a boundary intent with no ### Failure behaviour: state its timeouts and error responses as behaviours`, 'report')
    if (t.kind === 'boundary' && (!t.contractFiles.length || !t.exampleFiles.length)) add('boundary-contract', t.slug, `${t.slug} is a boundary intent: name a Contract: file and an Example: file under ## Interfaces`)
    for (const f of [...t.contractFiles, ...t.exampleFiles]) {
      if (escapes(f)) add('contract-path', t.slug, `${t.slug} names ${f}, which is outside the repo`)
      else if (!repoExists(f)) add('contract-path', t.slug, `${t.slug} names ${f}, which does not exist`)
    }
    for (const q of t.openQuestions) add('open-question', t.slug, `${t.slug} has an open question: ${q}`)
    for (const d of t.depends) if (!slugs.has(d)) add('depends', t.slug, `${t.slug} depends on ${d}, which is not an intent`)
    if (cycle.has(t.slug)) add('depends', t.slug, `${t.slug} is on a dependency cycle`)
  }
  const covered = new Set(i.intents.flatMap(t => t.prd))
  for (const id of defined) if (!covered.has(id)) add('req-uncovered', id, `${id} has no intent`)
  if (i.cases) {
    const byIntent = new Map(i.intents.map(t => [t.slug, new Set(t.behaviours.map(b => b.id))]))
    const mine = new Set(i.intents.map(t => t.slug))
    const theirs = new Set(others.map(t => t.slug))
    const rows = i.cases.filter(c => mine.has(c.intent) || !theirs.has(c.intent))
    for (const c of rows) {
      if (!c.reqs.length) add('case-untraced', c.id, `${c.id} cites no PRD requirement`)
      for (const id of c.reqs) if (!defined.has(id)) add('unknown-id', c.id, `${c.id} cites ${id}, which the PRD does not define`)
      if (!byIntent.get(c.intent)?.has(c.behaviour)) add('case-orphan', c.id, `${c.id} names ${c.intent}#${c.behaviour}, which does not exist`)
      if (c.data !== '-' && (escapes(c.data) || !i.exists(c.data))) add('case-data-missing', c.id, `${c.id} data ${c.data} does not exist`)
    }
    const tested = new Set(rows.flatMap(c => c.reqs))
    for (const id of defined) if (!tested.has(id)) add('req-untested', id, `${id} has no test case`)
  }
  const engineers = whole(frontmatter(prd).data.engineers) ?? 1
  const days = i.intents.reduce((n, t) => n + (t.estimateDays ?? 0), 0)
  if (days > SPRINT_DAYS * engineers) add('capacity', 'sprint', `${days} intent-days against ${SPRINT_DAYS * engineers} available (${engineers} engineer${engineers === 1 ? '' : 's'} × ${SPRINT_DAYS} days)`, 'report')
  return out
}

// An owner decision parked in a section the check does not block on (`## Risks`, `## Risks and notes`, `## Notes`) is reported, never blocked:
// a risk with an owner is legitimate, but a gap that needs a person's answer belongs under `## Concerns`.
export function parkedDecisions(where: string, text: string): ChartFinding[] {
  const body = uncomment(text.replace(/\r\n/g, '\n'))
  return (['Risks', 'Risks and notes', 'Notes'] as const).flatMap(h => section(body, h).split('\n').map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(l => /\bowner\s*:|\bdecision\b/i.test(l)).map((l): ChartFinding => ({ rule: 'parked-decision', severity: 'report', where, message: `${where} parks a decision under "${h}": ${l}` })))
}

// A change started from an intent keeps its behaviours (spec.md may drop the citations) and adds only ones that serve a requirement of the intent.
export function intentSpecProblems(intent: Intent, spec: string): string[] {
  const inSpec = parseBehaviours(spec)
  const known = new Set(intent.behaviours.map(b => b.id))
  return [
    ...intent.behaviours.filter(b => !inSpec.some(x => x.id === b.id)).map(b => `${b.id} of ${intent.slug} is missing from spec.md`),
    ...inSpec.filter(b => !known.has(b.id) && !b.reqs.some(r => intent.prd.includes(r))).map(b => `${b.id} is not in the intent ${intent.slug} and cites no requirement of ${intent.slug} (${intent.prd.join(', ') || 'none'})`),
  ]
}

// A fenced block, not mermaid, with a drawing in it: the ASCII twin of a mermaid diagram (owner, 2026-10-26: mermaid does not render in a terminal).
const asciiDiagram = (body: string): boolean =>
  [...body.matchAll(/^(```|~~~)([^\n]*)\n([\s\S]*?)^\1/gm)].some(m => !/mermaid/i.test(m[2] ?? '') && Boolean(m[3]?.trim()))

// What architecture.md must hold to be an architecture document and not a summary: the stack by name, a diagram, the code structure,
// a key flow, a tactic for every NFR the PRD defines, and this sprint's row in the history. Pure over text.
export function architectureProblems(arch: string, prd: string, sprint: number): ChartFinding[] {
  // A `#` line inside a fence (a tree, a shell snippet) must not end its section.
  const text = fencedText(arch)
  const out: ChartFinding[] = []
  const add = (rule: string, message: string): number => out.push({ rule, severity: 'block', where: 'architecture', message: `architecture.md ${message}` })
  const rows = (name: string): string[][] => tableRows(text, name)
  const stack = rows('Technology stack')
  for (const need of ['Language', 'Framework']) if (!stack.some(r => r[0]?.toLowerCase() === need.toLowerCase() && r[1])) add('arch-stack', `## Technology stack has no ${need} row with a Choice: name the real ${need.toLowerCase()} from the PRD ("none (standard library)" when there is no framework)`)
  if (!/^```mermaid/m.test(section(text, 'Architecture diagram'))) add('arch-diagram', 'has no mermaid diagram under ## Architecture diagram: draw the modules, the external systems and the dependency direction')
  if (!asciiDiagram(section(text, 'Architecture diagram'))) add('arch-diagram-text', 'has no ASCII diagram under ## Architecture diagram: draw the same modules and arrows in a ```text block beside the mermaid one, for terminals and plain-text readers')
  const tree = (/^```[^\n]*\n([\s\S]*?)^```/m.exec(section(text, 'Code structure'))?.[1] ?? '').split('\n').filter(l => l.trim())
  if (tree.length < 3) add('arch-structure', 'has no source tree under ## Code structure: show the directories and files this architecture implies, one comment each')
  if (!/^```mermaid/m.test(section(text, 'Key flows'))) add('arch-flow', 'has no mermaid sequence diagram under ## Key flows: draw the main use case through the modules')
  if (!asciiDiagram(section(text, 'Key flows'))) add('arch-flow-text', 'has no ASCII diagram under ## Key flows: draw the main flow in a ```text block beside the mermaid sequence diagram')
  const tactics = section(text, 'Quality tactics')
  for (const id of prdIds(prd).filter(x => x.startsWith('NFR-'))) if (!new RegExp(`\\b${id}\\b`).test(tactics)) add('arch-nfr', `## Quality tactics has no row for ${id}, which the PRD defines`)
  if (!rows('Sprint history').some(r => Number(/^(?:sprint[\s-]*)?(\d+)\.?$/i.exec(r[0] ?? '')?.[1]) === sprint)) add('arch-history', `## Sprint history has no row for sprint ${sprint}`)
  return out
}

const tableRows = (text: string, name: string): string[][] =>
  section(text, name).split('\n').filter(l => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]*$/.test(l)).map(cells)
// Backticks dropped and inner spaces collapsed, so `mobile  app` in a row and mobile app in a case are one name.
const norm = (s: string): string => s.replace(/`/g, '').replace(/\s+/g, ' ').trim()
const names = (cell: string): string[] => cell.split(',').map(s => norm(s).toLowerCase()).filter(Boolean)

// `| Action | Allowed | Interfaces | Intent |` rows under architecture.md `## Access`; `nobody` allows no role.
export function parseAccess(arch: string): AccessRule[] {
  return tableRows(uncomment(arch.replace(/\r\n/g, '\n')), 'Access').slice(1).map(c => ({
    action: norm(c[0] ?? ''), allowed: names(c[1] ?? '').filter(r => r !== 'nobody'), nobody: names(c[1] ?? '').includes('nobody'), interfaces: names(c[2] ?? ''), intent: norm(c[3] ?? ''),
  }))
}

// Permissions checked both ways (proposal 2026-10-23 §2): each row well formed and built by a charted intent; with cases, every interface of a
// row whose intent is this sprint's (`mine`, default every slug) has a refused case and, unless nobody may take the action, an allowed one. Shared backend code proves nothing about another interface.
export function accessProblems(rules: AccessRule[], slugs: string[], cases: TestCase[] | null, mine: string[] = slugs): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string): number => out.push({ rule, severity: 'block', where, message })
  const tested = new Set((cases ?? []).flatMap(c => { const m = /^(.+?):\s*(allowed|refused)\s+(.+)$/i.exec(norm(c.access)); return m ? [`${m[1]!.trim().toLowerCase()}|${m[2]!.toLowerCase()}|${m[3]!.toLowerCase()}`] : [] }))
  const seen = new Set<string>()
  for (const r of rules) {
    const nobody = r.nobody && !r.allowed.length
    if (seen.has(r.action.toLowerCase())) { add('access-row', r.action, `## Access lists "${r.action}" twice: one row per action`); continue }
    seen.add(r.action.toLowerCase())
    if (!r.action || !r.interfaces.length || !r.intent || (!r.allowed.length && !r.nobody)) { add('access-row', r.action || 'architecture', `## Access row "${r.action}" needs an action, allowed roles (or nobody), interfaces and an intent`); continue }
    if (!slugs.includes(r.intent)) add('access-intent', r.action, `## Access row "${r.action}" names ${r.intent}, which is not a charted intent`)
    if (cases && mine.includes(r.intent)) for (const i of r.interfaces) for (const way of nobody ? ['refused'] : ['allowed', 'refused'])
      if (!tested.has(`${r.action.toLowerCase()}|${way}|${i}`)) add('access-untested', r.action, `no case tests "${r.action}" ${way} on ${i}: add a case with Access "${r.action}: ${way} ${i}"`)
  }
  return out
}


// The sprint implementation plan (implementation-plan.md, owner 2026-10-26): how the sprint's intents are handed to engineers and built.
// `## Allocation` lanes cover every intent once and keep each lane in dependency order; a `### <slug>` section per intent has checkbox tasks
// and cites every behaviour of that intent, and no behaviour it does not have. Pure over text.
export function implementationPlanProblems(plan: string, intents: Intent[]): ChartFinding[] {
  const out: ChartFinding[] = []
  const add = (rule: string, where: string, message: string, severity: 'block' | 'report' = 'block'): number => out.push({ rule, severity, where, message: `implementation-plan.md ${message}` })
  const text = fencedText(plan)
  const by = new Map(intents.map(t => [t.slug, t]))
  const sections = new Map<string, string>()
  // `### <slug>` under `## Intents`; a heading may say more after the slug (`### cart-model (wave 2)`).
  for (const m of section(text, 'Intents').matchAll(/^###\s+`?([a-z0-9]+(?:-[a-z0-9]+)*)`?:?(?:\s[^\n]*)?$([\s\S]*?)(?=^###\s|(?![\s\S]))/gm)) sections.set(m[1]!, m[2] ?? '')
  for (const s of sections.keys()) if (!by.has(s)) add('impl-intent', s, `has a section for ${s}, which is not an intent of this sprint`)
  for (const t of intents) {
    const body = sections.get(t.slug)
    if (body === undefined) { add('impl-intent', t.slug, `has no \`### ${t.slug}\` section: plan every intent`); continue }
    if (!/^\s*[-*]\s+\[[ xX]\]\s+\S/m.test(body)) add('impl-tasks', t.slug, `### ${t.slug} has no \`- [ ]\` tasks`)
    const cited = new Set(body.match(/\bB\d+\b/g) ?? [])
    const known = new Set(t.behaviours.map(b => b.id))
    const unknown = [...cited].filter(b => !known.has(b))
    if (unknown.length) add('impl-behaviour', t.slug, `### ${t.slug} cites ${unknown.join(', ')}, which ${t.slug} does not have`)
    const missing = [...known].filter(b => !cited.has(b))
    if (missing.length) add('impl-behaviour', t.slug, `### ${t.slug} has no task for ${missing.join(', ')}: every behaviour gets a failing test first`)
  }
  const lanes = tableRows(text, 'Allocation').slice(1)
  if (!lanes.length) { add('impl-allocation', 'sprint', 'has no `## Allocation` table: one row per lane, its intents in build order'); return out }
  const placed = new Map<string, number>()
  for (const [i, row] of lanes.entries()) {
    const slugs = (row[1] ?? '').replace(/`/g, '').split(/\s*(?:,|→|->)\s*/).map(s => s.trim()).filter(Boolean)
    for (const [k, s] of slugs.entries()) {
      if (!by.has(s)) { add('impl-allocation', s, `lane ${row[0] || i + 1} names ${s}, which is not an intent of this sprint`); continue }
      placed.set(s, (placed.get(s) ?? 0) + 1)
      const later = by.get(s)!.depends.filter(d => slugs.indexOf(d) > k)
      if (later.length) add('impl-allocation', s, `lane ${row[0] || i + 1} puts ${s} before ${later.join(', ')}, which it depends on`)
    }
  }
  for (const t of intents) {
    const n = placed.get(t.slug) ?? 0
    if (n !== 1) add('impl-allocation', t.slug, n ? `allocates ${t.slug} to ${n} lanes: one lane per intent` : `allocates ${t.slug} to no lane`)
  }
  return out
}
