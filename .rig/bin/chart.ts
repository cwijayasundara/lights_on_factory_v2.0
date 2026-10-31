// The sprint chart on disk (outer-loop spec 2026-10-17 §5, §7): which files make up sprint N, their digest, a person's
// approval of them, and whether an intent can be started. A sprint's own files are its PRD, its intents, its test plan and the
// contract files those name, all under sprints/sprint-N/; the architecture and ADRs are shared and every sprint edits them.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, exists, read, sha, now, toPosix, frontmatter, skillRef } from './core.ts'
import { openQuestions, section } from './model.ts'
import { changeDir, isShipped } from './lifecycle.ts'
import { stripGenerated, carriedIds } from './carry.ts'
import { planText, type PlanRow } from './plan.ts'
import { prdFormatProblems, prdLedger, conversionProblems } from './prdformat.ts'
import { PRODUCT, ARCH_REL, archPath, prdPath, intentsDir, testplanDir, approvalPath, sprintDir, sprintsOnDisk, intentRel, planPath, implPlanPath, sprintRel, ledgerPath, waiversPath, reviewPath, sourcePath, conversionPath, conversionReviewPath } from './product.ts'
import { designIntents, sharedScopeProblems, architectureProblems, implementationPlanProblems, accessProblems, parseAccess, parseIntent, parseCases, parkedDecisions, prdIds, traceReport, ledgerProblems, parseLedger, parentOf, parseReview, openFindings, type ReviewFinding, type ChartWaiver, uncomment, escapes, type Intent, type ChartFinding } from './chartcheck.ts'

const SHARED_DIRS = ['adr'].map(d => `${toPosix(path.relative(ROOT, path.join(PRODUCT, d)))}/`)
export const CHART_RE = /^chart-(\d{1,4})$/
type ChartFile = { path: string; sha: string }
type ChartState = 'approved' | 'stale' | 'missing'
type Row = { by: string; at: string; digest: string; files: ChartFile[] }

const isShared = (p: string): boolean => p === ARCH_REL || SHARED_DIRS.some(d => p.startsWith(d))

// Dotfiles (.DS_Store, editor swap files) and backups (name~) are machine-local: hashing them would make a chart stale on every clone but the approver's.
const local = (name: string): boolean => name.startsWith('.') || name.endsWith('~')
function walk(dir: string): string[] {
  if (!exists(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !local(e.name)).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
}
const rel = (abs: string[]): string[] => [...new Set(abs.filter(f => exists(f)).map(f => toPosix(path.relative(ROOT, f))))].sort()

// The folder an intent sits in is its sprint; `declared` is what its frontmatter says, and a difference is a finding.
type Charted = Omit<Intent, 'sprint'> & { sprint: number; declared: number | null; file: string }
const allIntents = (): Charted[] => sprintsOnDisk().flatMap(n => {
  const dir = intentsDir(n)
  return exists(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md') && !local(f)).sort().map(f => { const file = path.join(dir, f), i = parseIntent(f.slice(0, -3), read(file)); return { ...i, declared: i.sprint, sprint: n, file } }) : []
})
export const intentsOf = (n: number): Charted[] => allIntents().filter(i => i.sprint === n)
// Whether /rig:start has nothing left to ask about a charted intent: every behaviour cites a requirement, nothing is open, no
// carried item waits and the non-goals are written. The reasons name what is missing.
export function intentSettled(slug: string): { settled: boolean; why: string[] } {
  const i = allIntents().find(x => x.slug === slug)
  if (!i) return { settled: false, why: ['not a charted intent'] }
  const text = read(i.file).replace(/<!--[\s\S]*?-->/g, '')
  const why = [
    ...(i.behaviours.length ? [] : ['no behaviours']),
    ...i.behaviours.filter(b => !b.reqs.length && !b.rules.length).map(b => `${b.id} cites no requirement`),
    ...openQuestions(text).map(q => `open: ${q}`),
    ...carriedIds(i.file).map(c => `carried ${c}`),
    ...(section(text, 'Non-goals').trim() ? [] : ['no non-goals']),
    ...(/^kind:\s*boundary/m.test(text) && !/Contract:/.test(text) ? ['a boundary with no Contract'] : []),
  ]
  return { settled: !why.length, why }
}
export const intentOf = (slug: string): Intent | null => allIntents().find(i => i.slug === slug) ?? null

// The sprint's design doc. `design:` in architecture.md frontmatter names the newest one (a repo-relative posix path, or `none`, or the template's
// `<path or none>` prompt left in); an older sprint's is the `<date>-sprint-<N>-design.md` beside it, so charting sprint 2 leaves sprint 1's design,
// and its approval, alone. The raw string comes back for a path outside the repo, so the design-missing rule can name it.
export function designDocOf(n: number): string | null {
  const arch = archPath
  const d = exists(arch) ? frontmatter(read(arch)).data.design?.trim() : undefined
  if (!d || d === 'none' || d.startsWith('<')) return null
  if (escapes(d)) return d
  const named = path.join(ROOT, path.dirname(d))
  const mine = exists(named) ? fs.readdirSync(named).filter(f => f.endsWith(`-sprint-${n}-design.md`)).sort().at(-1) : undefined
  const of = /-sprint-(\d+)-design\.md$/.exec(d)?.[1]
  if (!mine && of !== undefined && Number(of) !== n) return null // the newest design belongs to another sprint
  return toPosix(path.relative(ROOT, mine ? path.join(named, mine) : path.join(ROOT, d)))
}
const designFile = (n: number): string[] => { const d = designDocOf(n); return d && !escapes(d) ? [path.join(ROOT, d)] : [] }

function ownFiles(n: number): string[] {
  const own = intentsOf(n)
  return rel([prdPath(n), sourcePath(n), conversionPath(n), ledgerPath(n), waiversPath(n), ...designFile(n), implPlanPath(n), ...walk(testplanDir(n)), ...own.map(i => i.file), ...own.flatMap(i => [...i.contractFiles, ...i.exampleFiles]).filter(f => !escapes(f)).map(f => path.join(ROOT, f))])
}
const sharedFiles = (): string[] => rel([archPath, ...walk(path.join(PRODUCT, 'adr')).filter(f => f.endsWith('.md'))])
export const chartFiles = (n: number): string[] => [...new Set([...ownFiles(n), ...sharedFiles()])].sort()
// An intent's `owner:` line is left out of its hash: who builds an intent is decided after the chart is approved, and changing it
// is not a change to what was approved. The same goes for the sections `sdlc pr` generates (carried items, additions).
const INTENT_FILE = /^\.rig\/product\/sprints\/sprint-\d{1,4}\/intents\/[^/]+\.md$/
const hashed = (p: string): string => { const t = read(path.join(ROOT, p)); return INTENT_FILE.test(p) ? stripGenerated(t).replace(/^owner:[^\n]*\n/m, '') : t }
const manifest = (paths: string[]): ChartFile[] => paths.map(p => ({ path: p, sha: sha(hashed(p)) }))
export const chartDigest = (n: number): string => sha(manifest(chartFiles(n)).map(f => `${f.path}\n${f.sha}\n`).join(''))

function readRow(n: number): Row | null {
  try {
    const v = JSON.parse(read(approvalPath(n))) as Partial<Row>
    return typeof v.digest === 'string' && Array.isArray(v.files) && v.files.every(f => typeof f?.path === 'string' && typeof f?.sha === 'string') ? (v as Row) : null
  } catch { return null }
}
// Approval accepts the sprint's proposed ADRs and their Decisions rows, so "never edit an accepted ADR" can bite (2026-10-25 shop_app).
function acceptAdrs(n: number): void {
  const ids = walk(path.join(PRODUCT, 'adr')).filter(f => f.endsWith('.md')).flatMap(f => {
    const text = read(f), fm = frontmatter(text).data
    const next = text.replace(/^status:\s*["']?proposed["']?[ \t]*$/m, 'status: accepted')
    if (fm.sprint !== String(n) || fm.status !== 'proposed' || next === text) return [] // the Decisions row flips only with the file
    fs.writeFileSync(f, next)
    return [/^\d+/.exec(path.basename(f))?.[0]].filter((x): x is string => Boolean(x))
  })
  if (ids.length && exists(archPath)) fs.writeFileSync(archPath, read(archPath).replace(new RegExp(`^(\\|\\s*(?:\\[(?:${ids.join('|')})\\]\\([^)]*\\)|(?:${ids.join('|')}))\\s*\\|.*\\|\\s*)proposed(\\s*\\|\\s*${n}\\s*\\|\\s*)$`, 'gm'), '$1accepted$2'))
}
export function writeChartApproval(n: number, by: string): void {
  acceptAdrs(n)
  const row: Row = { by, at: now(), digest: chartDigest(n), files: manifest(chartFiles(n)) }
  fs.mkdirSync(sprintDir(n), { recursive: true })
  fs.writeFileSync(approvalPath(n), JSON.stringify(row, null, 2) + '\n')
}
const approvedSprints = (): number[] => sprintsOnDisk().filter(n => exists(approvalPath(n)))

// The paths of `current` that differ from what `row` recorded (kept by `keep`), plus recorded paths now gone.
function drift(row: Row, current: ChartFile[], keep: (p: string) => boolean): string[] {
  const before = new Map(row.files.filter(f => keep(f.path)).map(f => [f.path, f.sha]))
  return [...current.filter(f => before.get(f.path) !== f.sha).map(f => f.path), ...[...before.keys()].filter(p => !current.some(f => f.path === p))].sort()
}
// Own files must match this sprint's approval. Shared files must match it too, or match the approval of a later sprint whose
// own files still match its approval: charting sprint N+1 edits the architecture and test plan, and once a person approves
// chart-(N+1) the unstarted intents of sprint N stay startable.
export function chartState(n: number): { state: ChartState; changed: string[] } {
  const row = readRow(n)
  if (!row) return { state: 'missing', changed: chartFiles(n) }
  const own = drift(row, manifest(ownFiles(n)), p => !isShared(p))
  const sharedNow = manifest(sharedFiles())
  const sharedBy = (m: number): boolean => {
    const r = readRow(m)
    return Boolean(r) && drift(r as Row, sharedNow, isShared).length === 0 && (m === n || drift(r as Row, manifest(ownFiles(m)), p => !isShared(p)).length === 0)
  }
  const sharedOk = sharedBy(n) || approvedSprints().some(m => m > n && sharedBy(m))
  const changed = [...own, ...(sharedOk ? [] : drift(row, sharedNow, isShared))].sort()
  return { state: changed.length ? 'stale' : 'approved', changed }
}

// The trace rules over the files, plus what only the files can say: unresolved concerns and the architecture's open questions.
export function chartFindings(n: number, withCases: boolean): ChartFinding[] {
  const testplan = testplanDir(n)
  const cases = withCases ? parseCases(read(path.join(testplan, 'cases.md'))) : null
  const found = traceReport({
    prd: read(prdPath(n)), intents: intentsOf(n), others: allIntents().filter(i => i.sprint !== n), repoExists: p => exists(path.join(ROOT, p)), cases,
    exists: p => exists(path.join(testplan, p)),
  })
  // A sprint approved before the ledger existed is not made to grow one; any sprint never approved is.
  const prd = read(prdPath(n))
  const format = prdFormatProblems(prd)
  const unapproved = chartState(n).state !== 'approved'
  found.push(...ledgerProblems({ prd, ledger: exists(ledgerPath(n)) ? read(ledgerPath(n)) : null, intents: intentsOf(n), cases, required: chartState(n).state === 'missing' || Boolean(readRow(n)?.files.some(f => f.path.endsWith('/requirements.md'))), inFormat: !format.length }))
  // The format flow (a sprint with source.md, or an in-format PRD with a ledger): the PRD must be in format and the ledger generated from it.
  if (unapproved && exists(sourcePath(n)) && format.length) found.push({ rule: 'prd-format', severity: 'block', where: 'prd', message: `prd.md is not in rig's PRD format (${format.length} finding(s)): run \`prd check ${n}\` and convert it` })
  if (unapproved && !format.length && exists(ledgerPath(n)) && read(ledgerPath(n)) !== prdLedger(prd)) found.push({ rule: 'ledger-stale', severity: 'block', where: 'ledger', message: `requirements.md is not what prd.md generates: run \`prd ledger ${n}\`, never edit it by hand` })
  for (const i of intentsOf(n)) if (i.declared !== n) found.push({ rule: 'sprint-mismatch', severity: 'block', where: i.slug, message: `${i.slug} sits in sprint-${n}/intents/ but its frontmatter says sprint: ${i.declared ?? 'nothing'}` })
  for (const i of intentsOf(n)) {
    const same = allIntents().filter(t => t.slug === i.slug)
    if (same.length > 1) found.push({ rule: 'duplicate-slug', severity: 'block', where: i.slug, message: `${i.slug} is an intent of more than one sprint (${same.map(t => `sprint ${t.sprint}`).join(', ')}); a slug names one change` })
  }
  const design = designDocOf(n)
  if (design && (escapes(design) || !exists(path.join(ROOT, design)))) found.push({ rule: 'design-missing', severity: 'block', where: 'architecture', message: `architecture.md names a design doc that does not exist: ${design}` })
  else if (design) {
    const listed = designIntents(read(path.join(ROOT, design)))
    const mine = intentsOf(n).map(i => i.slug)
    for (const s of listed.filter(x => !mine.includes(x))) found.push({ rule: 'design-intent', severity: 'block', where: 'architecture', message: `${s} is in the design doc's ## Intents but has no ${intentRel(n, s)} (the list is read from \`- <slug>: scope\` lines; slugs are lowercase kebab-case)` })
    for (const s of mine.filter(x => !listed.includes(x))) found.push({ rule: 'design-intent', severity: 'block', where: s, message: `${s} is an intent of sprint ${n} but the design doc's ## Intents does not list it` })
  }
  const arch = uncomment(read(archPath))
  found.push(...architectureProblems(arch, read(prdPath(n)), n))
  found.push(...accessProblems(parseAccess(arch), allIntents().map(i => i.slug), cases, intentsOf(n).map(i => i.slug)))
  for (const q of openQuestions(arch)) found.push({ rule: 'open-question', severity: 'block', where: 'architecture', message: `architecture.md has an open question: ${q}` })
  for (const l of section(arch, 'Concerns').split('\n').map(x => x.replace(/^\s*[-*]\s*/, '').trim()).filter(x => x && !/^none\.?$/i.test(x) && !/^\[x\]/i.test(x) && !/\(resolved\)/i.test(x))) found.push({ rule: 'concern', severity: 'block', where: 'architecture', message: `unresolved concern: ${l}` })
  found.push(...(exists(implPlanPath(n)) ? implementationPlanProblems(read(implPlanPath(n)), intentsOf(n))
    : intentsOf(n).length ? [{ rule: 'impl-missing', severity: 'block' as const, where: 'sprint', message: `${sprintRel(n)}/implementation-plan.md is missing: write it as implementation-plan-format.md lays it out` }] : []))
  for (const [where, file] of [['architecture.md', archPath], ...intentsOf(n).map(i => [`${i.slug}.md`, i.file] as const)]) found.push(...parkedDecisions(where, read(file)))
  found.push(...sharedScopeProblems(intentsOf(n), allIntents()))
  return found
}

// The review findings that still stop approval, or null when the sprint has no chart-review.md.
const chartWaivers = (n: number): ChartWaiver[] => { try { const v = JSON.parse(read(waiversPath(n))) as unknown; return Array.isArray(v) ? (v as ChartWaiver[]) : [] } catch { return [] } }
export const chartReview = (n: number): ReviewFinding[] | null => (exists(reviewPath(n)) ? parseReview(read(reviewPath(n))) : null)
export function chartOpenFindings(n: number): ReviewFinding[] | null {
  const review = chartReview(n)
  return review && openFindings(review, chartWaivers(n))
}
// A person's waiver of finding `k`: kept with the text it covered, so editing the finding re-opens it.
export function waiveChartFinding(n: number, f: ReviewFinding, by: string, reason: string): void {
  const row: ChartWaiver = { finding: f.n, text_sha: f.sha, by, at: now(), reason }
  fs.writeFileSync(waiversPath(n), JSON.stringify([...chartWaivers(n).filter(w => w.finding !== f.n), row], null, 2) + '\n')
}

// The ledger rows an intent cites, as the lines of a change's requirements.md: a `prd:` id brings every rule and answer row under
// it, a behaviour's ledger id or AC alias brings that row. Lines are copied from the ledger as they are; null with no ledger.
export function changeRequirements(slug: string): string | null {
  const i = intentOf(slug)
  const n = i?.sprint ?? null
  if (!i || n === null || !exists(ledgerPath(n))) return null
  const text = read(ledgerPath(n))
  const ids = new Set(i.behaviours.flatMap(b => b.rules))
  const rows = new Set(parseLedger(text).filter(r => ((r.kind === 'rule' || r.kind === 'answer') && i.prd.includes(parentOf(r.id) ?? '')) || ids.has(r.id) || (r.alias !== null && ids.has(r.alias))).map(r => r.id))
  const lines = text.split('\n').filter(l => { const id = /^\s*[-*]\s+(\S+)/.exec(l)?.[1]; return id !== undefined && rows.has(id) })
  return `# Requirements: ${slug}\n\n<!-- Copied by rig from ${sprintRel(n)}/requirements.md, the PRD's own words: never edit it; a behaviour must not contradict it. -->\n\n${lines.join('\n')}\n`
}

// ---------- the converted PRD (spec 2026-10-26 PRD format; one gate since 2026-10-27) ----------
// `approve prd-N` is gone: the chart approval hashes prd.md, source.md and conversion.md with the rest, so it is the one gate.
export const PRD_RE = /^prd-(\d{1,4})$/
// Converted: the person's original (source.md) is not the PRD rig decomposes, so the chart approval checks the conversion too.
// Judged on the text, and a sprint stays converted once conversion.md exists, so deleting or overwriting source.md cannot
// skip that check; an original that was already in format (answers added at chart aside) is the person's own PRD.
export const isConverted = (n: number): boolean => exists(conversionPath(n)) || (exists(sourcePath(n)) && prdFormatProblems(read(sourcePath(n))).length > 0)
// Why the conversion of a converted sprint stops its chart approval, or null.
export function conversionRefusal(n: number): string | null {
  if (!exists(sourcePath(n))) return `chart-${n} decomposes a converted PRD but source.md, the person's original, is missing: restore it from git`
  const prd = read(prdPath(n))
  const found = [...prdFormatProblems(prd), ...conversionProblems({ source: read(sourcePath(n)), prd, map: exists(conversionPath(n)) ? read(conversionPath(n)) : null })]
  if (found.length) return `the conversion of prd-${n} has ${found.length} finding(s):\n${found.map(f => `  [${f.rule}] ${f.where}: ${f.message}`).join('\n')}`
  const open = openQuestions(prd)
  if (open.length) return `prd.md has open question(s); answer each in prd.md first:\n${open.map(q => `  - ${q}`).join('\n')}`
  const review = exists(conversionReviewPath(n)) ? parseReview(read(conversionReviewPath(n))).filter(f => f.status === 'open' || f.status === 'reopened') : []
  return review.length ? `conversion-review.md has ${review.length} finding(s) not fixed:\n${review.map(f => `  ${f.n}. ${f.text}`).join('\n')}` : null
}

// Whether an intent can be started now, and if not, why.
export function intentReady(slug: string): { ready: boolean; why: string[] } {
  const i = allIntents().find(t => t.slug === slug)
  if (!i) return { ready: false, why: [`no such intent: ${slug}`] }
  if (exists(changeDir(slug))) return { ready: false, why: ['already started'] }
  const why: string[] = []
  const s = chartState(i.sprint)
  if (s.state === 'missing') why.push(`chart-${i.sprint} is not approved`)
  else if (s.state === 'stale') why.push(`chart-${i.sprint} is stale: run ${skillRef('approve')} chart-${i.sprint} after reviewing (changed: ${s.changed.join(', ')})`)
  const blocked = i.depends.filter(d => !isShipped(d))
  if (blocked.length) why.push(`blocked by ${blocked.join(', ')}`)
  return { ready: !why.length, why }
}

// Sprint numbers that have a folder or an intent, ascending: the journey view's way to find the sprint in flight.
export function sprintsKnown(): number[] {
  return [...new Set([...sprintsOnDisk(), ...allIntents().map(i => i.sprint)])].sort((a, b) => a - b)
}

// What /rig:chart works on when given no argument: the PRDs of sprints with no intents yet, from the sprint folder or docs/prd
// (sprint-<N>/prd.md, sprint-<N>-<title>/prd.md, sprint-<N>.md, sprint-<N>-<title>.md). One candidate is the answer; several are a question.
export type NextChart = { sprint: number | null; prd: string | null; candidates: { sprint: number; prd: string }[]; why: string }
export function nextChart(): NextChart {
  const found = new Map<number, string>()
  for (const n of sprintsOnDisk()) if (exists(prdPath(n))) found.set(n, `${sprintRel(n)}/prd.md`)
  const docs = path.join(ROOT, 'docs', 'prd')
  const rank = (e: fs.Dirent): number => (/^sprint-\d+(\.md)?$/.test(e.name) ? 0 : 2) + (e.isDirectory() ? 0 : 1)
  for (const e of (exists(docs) ? fs.readdirSync(docs, { withFileTypes: true }) : []).sort((a, b) => rank(a) - rank(b))) {
    const m = /^sprint-(\d{1,4})(?:-.+?)?(\.md)?$/.exec(e.name)
    const n = Number(m?.[1])
    const rel = e.isDirectory() ? `docs/prd/${e.name}/prd.md` : m?.[2] ? `docs/prd/${e.name}` : null
    if (m && rel && exists(path.join(ROOT, rel)) && !found.has(n)) found.set(n, rel)
  }
  const candidates = [...found].filter(([n]) => !intentsOf(n).length).sort(([a], [b]) => a - b).map(([sprint, prd]) => ({ sprint, prd }))
  if (candidates.length === 1) return { sprint: candidates[0]!.sprint, prd: candidates[0]!.prd, candidates, why: 'the one PRD with no intents yet' }
  if (candidates.length) return { sprint: null, prd: null, candidates, why: `${candidates.length} PRDs have no intents yet: ask which one` }
  const known = sprintsKnown()
  return { sprint: known.length ? Math.max(...known) + 1 : 0, prd: null, candidates, why: 'no PRD without intents: the next sprint number, but no PRD to chart; ask for its path' }
}
export const sprintIntents = (n: number): string[] => intentsOf(n).map(i => i.slug)

// Every intent that can start now.
export function readyIntents(): { slug: string; sprint: number; estimateDays: number | null }[] {
  return allIntents().filter(i => i.sprint !== null && intentReady(i.slug).ready).map(i => ({ slug: i.slug, sprint: i.sprint, estimateDays: i.estimateDays }))
}

// The chain for one sprint and how far the work has got: requirement → intent → behaviour → test case, then started and shipped.
export function chartReport(n: number): string {
  const intents = intentsOf(n)
  const cases = parseCases(read(path.join(testplanDir(n), 'cases.md')))
  const ids = prdIds(read(prdPath(n)))
  const inCase = (id: string): string[] => cases.filter(c => c.reqs.includes(id)).map(c => c.id)
  const chain = ids.map(id => `  ${id} → ${intents.filter(i => i.prd.includes(id)).map(i => `${i.slug}#${i.behaviours.filter(b => b.reqs.includes(id)).map(b => b.id).join(',')}`).join(' ') || '(no intent)'} → ${inCase(id).join(' ') || '(no test case)'}`)
  const started = intents.filter(i => exists(changeDir(i.slug))).length
  const shipped = intents.filter(i => isShipped(i.slug)).length
  const days = intents.reduce((sum, i) => sum + (i.estimateDays ?? 0), 0)
  return [
    `chart-${n}: ${chartState(n).state}`,
    `requirements ${ids.length}: with an intent ${ids.filter(id => intents.some(i => i.prd.includes(id))).length}, with a test case ${ids.filter(id => inCase(id).length).length}`,
    `intents ${intents.length} (${days} engineer-days): started ${started}, shipped ${shipped}`,
    `carried in ${intents.reduce((c, i) => c + carriedIds(i.file).length, 0)}, added during changes ${intents.reduce((c, i) => c + section(read(i.file), 'Added during the change').split('\n').filter(l => /^\s*[-*]\s/.test(l)).length, 0)}, backlog open ${read(path.join(PRODUCT, 'backlog.md')).split('\n').filter(l => /^\s*[-*]\s+\[open\]/.test(l)).length}`,
    ...chain,
  ].join('\n')
}

// The sprint plan view: waves and graphs generated from the intents' `depends:` lines (see plan.ts), written beside the PRD. Not a chart
// file, so regenerating it never makes an approved chart stale.
export function planRows(n: number, assumeShipped?: string | string[]): PlanRow[] {
  const shipped = (x: string): boolean => [assumeShipped].flat().includes(x) || isShipped(x)
  return intentsOf(n).map(i => ({
    slug: i.slug, depends: i.depends, estimateDays: i.estimateDays, owner: i.owner,
    status: shipped(i.slug) ? 'done' : exists(changeDir(i.slug)) ? 'active' : i.depends.every(shipped) ? 'ready' : 'blocked',
  }))
}
export function sprintPlan(n: number, assumeShipped?: string | string[]): string {
  return planText(n, planRows(n, assumeShipped), { chart: chartState(n).state, startCmd: slug => `${skillRef('start')} ${slug}` })
}
export function writePlan(n: number, assumeShipped?: string | string[]): string {
  fs.mkdirSync(sprintDir(n), { recursive: true })
  fs.writeFileSync(planPath(n), sprintPlan(n, assumeShipped))
  return `${sprintRel(n)}/plan.md`
}
// The start commands of the sprint's intents that are ready once `slug` ships; [] for an uncharted change.
export function readyAfter(slug: string): string[] {
  const n = intentOf(slug)?.sprint
  if (typeof n !== 'number') return []
  return planRows(n, slug).filter(r => r.status === 'ready').map(r => `${skillRef('start')} ${r.slug}`)
}
