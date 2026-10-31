// `sdlc.ts learn <mine|replay|check|status>` (learning loop design 2026-10-17). Deterministic and zero tokens: it reads committed evidence
// and writes only under .rig/learn/. The model-facing step is the /rig:learn skill; a person applies every change to the lessons and the rules.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, WAIVERS, ensureGitignore, out, fail, read, listChanges, readJsonl, writeAtomic, usdOpt, sha, type Args, type Waiver } from './core.ts'
import { parseLessons, checkLessons, type Lesson } from './learnfile.ts'
import { mineCandidates, shippedChanges, lessonStatus } from './learnmine.ts'
import { replayRule, replayLayers } from './learnreplay.ts'
import { mineTranscripts, projectDirs, repeated } from './learntranscripts.ts'
import { parseRules, ghBin, type Rule } from './model.ts'
import { execFileSync } from 'node:child_process'
import { writeCandidates, readCases, reviewEval, briefPath, EVAL_LOG } from './reviewcases.ts'

const LESSONS = path.join(SDLC, 'lessons.md')
const ARCHIVE = path.join(SDLC, 'lessons-archive.md')
const LEARN = path.join(SDLC, 'learn')

const allLessons = (): Lesson[] => [...parseLessons(read(LESSONS)).lessons, ...parseLessons(read(ARCHIVE)).lessons]

function analyse() {
  const candidates = mineCandidates(ROOT)
  const waivers = readJsonl<Waiver>(WAIVERS)
  const status = lessonStatus(allLessons(), shippedChanges(ROOT), waivers)
  return { candidates, ...status }
}

function mine(): void {
  const a = analyse()
  fs.mkdirSync(LEARN, { recursive: true })
  writeAtomic(path.join(LEARN, 'candidates.json'), JSON.stringify(a, null, 2) + '\n')
  out([
    a.candidates.length ? `${a.candidates.length} candidate(s):` : 'no candidates: nothing recurs in two changes yet',
    ...a.candidates.map(c => `- ${c.kind} ${c.key}: ${c.changes.length} changes (${c.changes.join(', ')}), ${c.count} occurrence(s)\n    ${c.sample}\n    strongest fix that fits: ${c.rung}: ${c.how}`),
    ...a.retire.map(r => `retire ${r.id}: ${r.why}`),
    'written: .rig/learn/candidates.json',
  ].join('\n'))
}

// `learn mine --transcripts`: the person's typed turns from this repo's transcripts, for the skill to group. RIG_TRANSCRIPTS_DIR overrides the
// folder (tests, evals). The file stays under the gitignored .rig/learn/.
function mineCorrections(): void {
  const tried = process.env.RIG_TRANSCRIPTS_DIR ? [process.env.RIG_TRANSCRIPTS_DIR] : projectDirs(ROOT)
  const dir = tried.find(d => fs.existsSync(d)) ?? tried[0]!
  ensureGitignore()
  const corrections = mineTranscripts(dir)
  const again = repeated(corrections)
  fs.mkdirSync(LEARN, { recursive: true })
  writeAtomic(path.join(LEARN, 'corrections.json'), JSON.stringify({ corrections, repeated: again }, null, 2) + '\n')
  const sessions = new Set(corrections.map(c => c.session)).size
  out([corrections.length ? `${corrections.length} typed turn(s) from ${sessions} session(s); ${again.length} repeated in 2+ sessions` : 'no transcripts for this repo', `read: ${tried.find(d => fs.existsSync(d)) ?? `nothing at ${tried.join(' or ')}`}`, 'written: .rig/learn/corrections.json'].join('\n'))
}

// A proposal line that promotes a lesson to a rule (PROMOTE) or a layer edge (LAYER) is presentable only with a passing replay of exactly the file
// it proposes: the replay wrote .rig/learn/replay-<file>.json with the file's hash, and a changed file invalidates it.
// Any spelling a model might use for the line: bullet or not, bold or not, any case, `:` or a dash after the id.
const PROMOTION = /^(?:[-*]\s*)?[*`]*(PROMOTE|LAYER)[*`]*\s+`?([^\s:`*]+)`?\**\s*[:\u2013\u2014-]/i
export function proposalProblems(proposal: string, readFile: (rel: string) => string | null): string[] {
  return proposal.split('\n').flatMap(line => {
    const m = PROMOTION.exec(line.trim())
    if (!m) return []
    const [verb, id] = [(m[1] as string).toUpperCase(), m[2] as string]
    const file = verb === 'PROMOTE' ? `rule-${id}.json` : `layers-${id}.md`
    const text = readFile(`.rig/learn/${file}`)
    if (text === null) return [`${verb} ${id}: ${file} is not in .rig/learn/`]
    let ev: { file?: string; sha?: string; pass?: boolean } | null = null
    try { ev = JSON.parse(readFile(`.rig/learn/replay-${file.replace(/\.[a-z]+$/, '')}.json`) ?? 'null') } catch { /* none */ }
    if (!ev) return [`${verb} ${id}: no replay on record: run \`learn replay ${verb === 'LAYER' ? '--layers ' : ''}.rig/learn/${file} --earned <a>,<b>\``]
    if (ev.sha !== sha(text)) return [`${verb} ${id}: ${file} changed since its replay; replay it again`]
    return ev.pass ? [] : [`${verb} ${id}: its replay failed, so it is not presentable`]
  })
}
const proposalCheck = (): string[] => proposalProblems(read(path.join(LEARN, 'proposal.md')), rel => (fs.existsSync(path.join(ROOT, rel)) ? read(path.join(ROOT, rel)) : null))

function check(): void {
  const slugs = listChanges()
  const problems = [
    ...proposalCheck(),
    ...checkLessons(read(LESSONS), slugs),
    ...checkLessons(read(ARCHIVE), slugs),
    ...parseLessons(read(LESSONS)).lessons.filter(l => l.status !== 'active').map(l => `${l.id}: ${l.status} lessons belong in .rig/lessons-archive.md`),
    ...parseLessons(read(ARCHIVE)).lessons.filter(l => l.status === 'active').map(l => `${l.id}: active lessons belong in .rig/lessons.md`),
  ]
  out(problems.length ? problems.map(p => `[learn] ${p}`).join('\n') : 'learn check: lessons are well formed')
  process.exitCode = problems.length ? 1 : 0
}

function readRule(file: string | undefined): Rule {
  const abs = file ? path.resolve(ROOT, file) : ''
  let v: unknown
  try { v = JSON.parse(fs.readFileSync(abs, 'utf8')) } catch { return fail(`cannot read the rule file ${file ?? '(none given)'}: pass a JSON rule {id, pattern, message, why, action}`) }
  const { rules, errors } = parseRules(JSON.stringify([v]))
  if (errors.length || !rules[0]) return fail(`the rule file is not a valid rule: ${errors.join('; ')}`)
  return rules[0]
}

function replay(args: Args): void {
  const earned = String(args.opt.earned ?? '').split(',').filter(Boolean)
  if (earned.length < 2) fail('replay needs --earned <slug>,<slug>: the (at least 2) changes that earned the fix')
  if (args.opt.layers === true) fail('--layers needs the file: learn replay --layers .rig/learn/layers-<id>.md --earned a,b')
  const layersFile = typeof args.opt.layers === 'string' ? args.opt.layers : null
  const given = layersFile ?? args.pos[1]
  const r = layersFile ? replayLayers(ROOT, read(path.resolve(ROOT, layersFile)), earned, listChanges()) : replayRule(ROOT, readRule(args.pos[1]), earned, listChanges())
  const pass = r.pass
  // The evidence a proposal line is checked against: what was replayed (by hash), on whom, and whether it held.
  if (given && fs.existsSync(path.resolve(ROOT, given))) {
    fs.mkdirSync(LEARN, { recursive: true })
    writeAtomic(path.join(LEARN, `replay-${path.basename(given).replace(/\.[a-z]+$/, '')}.json`), JSON.stringify({ file: path.basename(given), sha: sha(read(path.resolve(ROOT, given))), earned, pass, at: new Date().toISOString() }, null, 2) + '\n')
  }
  out([
    r.error ? `error: ${r.error}` : `fires on: ${r.firesOn.join(', ') || 'none'}`,
    r.missed.length ? `does not fire on an earning change: ${r.missed.join(', ')}` : '',
    r.extra.length ? `also fires on: ${r.extra.join(', ')}` : '',
    r.skipped.length ? `skipped (diff not recoverable${earned.some(e => r.skipped.includes(e)) ? ', and an earning change cannot be replayed' : ''}): ${r.skipped.join(', ')}` : '',
    pass ? 'replay: pass' : 'replay: fail',
  ].filter(Boolean).join('\n'))
  process.exitCode = pass ? 0 : 1
}

function status(): void {
  const a = analyse()
  const active = parseLessons(read(LESSONS)).lessons.filter(l => l.status === 'active').length
  out(`learn: active ${active}, eligible ${a.candidates.length}, flagged ${a.retire.length}`)
}

// Merged PRs labelled `revert` in this repo, or null when gh cannot say (no gh, no remote, no auth).
function revertLabelled(): number[] | null {
  try { return (JSON.parse(execFileSync(ghBin(), ['api', '--paginate', '--slurp', 'search/issues?q=repo:{owner}/{repo}+is:pr+is:merged+label:revert&per_page=100'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })) as { items?: { number?: number }[] }[]).flatMap(p => p.items ?? []).map(i => Number(i.number)).filter(Number.isFinite) } catch { return null }
}

export function cmdLearn(args: Args): void {
  const sub = args.pos[0]
  if (sub === 'mine') return args.opt.transcripts ? mineCorrections() : mine()
  if (sub === 'check') return check()
  if (sub === 'proposal') { const p = proposalCheck(); out(p.length ? p.map(x => `[learn] ${x}`).join('\n') : 'learn proposal: every promotion carries a passing replay'); process.exitCode = p.length ? 1 : 0; return }
  if (sub === 'replay') return replay(args)
  if (sub === 'status') return status()
  if (sub === 'review-eval') {
    const maxUsd = usdOpt(args, Number.MIN_VALUE) // any positive amount
    if (maxUsd === null || Number.isNaN(maxUsd)) fail('learn review-eval costs money: pass --max-usd <dollars> (a positive number), the most this run may spend')
    const model = typeof args.opt.model === 'string' ? args.opt.model : undefined
    const prior = readJsonl<{ brief: string; model: string; caught: number; cases: number; at: string }>(EVAL_LOG(ROOT))
    const r = reviewEval(ROOT, { maxUsd, model })
    const now = readJsonl<{ brief: string; model: string }>(EVAL_LOG(ROOT)).at(-1)
    const before = [...prior].reverse().find(p => p.brief === now?.brief || p.model === now?.model)
    out([`caught ${r.caught} of ${r.scored} confirmed case(s)${r.failed ? `, ${r.failed} failed to run` : ''} (brief ${now?.brief}, ${now?.model}, $${r.usd})`, before ? `before: caught ${before.caught} of ${before.cases} (brief ${before.brief}, ${before.model}, ${before.at.slice(0, 10)})` : 'before: no earlier run', `brief: ${path.relative(ROOT, briefPath(ROOT))}`].join('\n'))
    return
  }
  if (sub === 'reverts') { const labelled = revertLabelled(); const r = writeCandidates(ROOT, labelled ?? []); const bad = readCases(ROOT).bad; out([`review cases: ${r.added.length} new, ${r.total} total, ${r.confirmed} confirmed (.rig/learn/review-cases/)`, ...r.added.map(n => `  + ${n}`), ...bad.map(n => `  ! ${n}: unreadable, skipped`), labelled ? '' : 'note: could not list merged PRs labelled revert (gh); only `This reverts commit` reverts were read', r.total > r.confirmed ? 'to confirm one: a person who knows the code sets defect.file, defect.pattern and confirmed: true in its file' : ''].filter(Boolean).join('\n')); return }
  fail('usage: learn <mine [--transcripts]|replay <rule.json>|--layers <block.md> --earned a,b|proposal|check|status|reverts|review-eval --max-usd <n> [--model <id>]>')
}
