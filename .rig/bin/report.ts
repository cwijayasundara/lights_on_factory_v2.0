// `sdlc report`: how the harness is doing, from git and the change records alone (harness readiness 0.3). Deterministic and free:
// no network, no model, no money. It never reports a PR count as a result, only as the denominator. What git cannot tell it
// (CI outcomes, review time, findings fixed without a person) is listed as unavailable instead of being guessed.
import path from 'node:path'
import { ROOT, ageDays, out, readJson, readJsonl, gitIn, type Args } from './core.ts'
import { mineCandidates, shippedChanges } from './learnmine.ts'
import type { RunRow } from './runs.ts'
import { changeHistory } from './reverts.ts'
import { gh } from './model.ts'

export type Report = {
  merged: number; shipped: number; since: string | null // merged: every change whose pr.md a merge added; shipped: those whose records are still in the tree (a revert removes them)
  prLines: { median: number; max: number } | null // lines changed outside .rig/ by the commit on the first-parent line that added each change's pr.md (a rebase merge counts only that commit)
  firstPass: { measured: number; clean: number } // changes whose recorded runs (runs.jsonl) all passed, expected failures aside
  reverted: number // merged changes a later commit says it reverts
  tiers: Record<'0' | '1' | '2' | 'unknown', { merged: number; reverted: number }> // the tier each merge shipped at (its committed pr-body.md); unknown: no Risk section
  hoursToApproval: { median: number; of: number } | null // first commit on the change to its person approval; of: the changes with both dates (a squash can hide the first commit)
  waiversPerChange: number
  waiverRows: { unowned: number; oldestDays: number | null } // Infinity: a row with no readable date; every waiver on record: rows with no owner, and the age of the oldest
  repeat: { classes: number; changes: number } // finding and waiver classes seen in 2+ changes, and the changes carrying one
  unavailable: string[]
  humanTime?: HumanTime | { unavailable: string } // only with --github: GitHub holds it, git does not
}

// Human time per merged PR (the Claude Code code-review article's measures), from GitHub. Bots and the PR's author never count: an agent's
// approval is not a human's, and an author commenting on their own PR is not review.
export type HumanTime = {
  prs: number // merged PRs read (the most recent `limit` in the window)
  approvals: { median: number; p95: number } // distinct humans whose latest review of the PR is an approval
  comments: { median: number; p95: number } // review comments, review bodies and conversation comments by humans other than the author
  waitHours: { median: number; p95: number; of: number } | null // PR opened to the first human review; of: the PRs that had one
  unreviewed: number // merged with no human review at all
}

type GhUser = { login?: string; type?: string } | null
type GhPull = { number: number; merged_at: string | null; created_at: string; user: GhUser }
type GhReview = { user: GhUser; state: string; submitted_at?: string; body?: string | null }
type GhComment = { user: GhUser }
export type GhFetch = (endpoint: string) => unknown[]

const human = (u: GhUser): u is { login: string; type?: string } => Boolean(u?.login) && u?.type !== 'Bot' && !u?.login?.endsWith('[bot]')
const pctile = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0) : 0 }
const stat = (xs: number[]): { median: number; p95: number } => ({ median: median(xs), p95: pctile(xs, 0.95) })

// `gh api --paginate --slurp` answers a list of pages; the pages are joined.
export const ghFetch = (root: string): GhFetch => endpoint => (JSON.parse(gh(['api', '--paginate', '--slurp', endpoint], root)) as unknown[][]).flat()

export function humanTime(fetch: GhFetch, since: string | null, limit = 50): HumanTime | { unavailable: string } {
  try {
    const pulls = (fetch('repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100') as GhPull[])
      .filter(p => p.merged_at && (!since || p.merged_at.slice(0, 10) >= since)).sort((a, b) => Date.parse(b.merged_at!) - Date.parse(a.merged_at!)).slice(0, limit) // the list is by last update, not merge
    const approvals: number[] = [], comments: number[] = [], waits: number[] = []
    for (const pr of pulls) {
      const author = pr.user?.login
      const reviews = (fetch(`repos/{owner}/{repo}/pulls/${pr.number}/reviews?per_page=100`) as GhReview[]).filter(r => human(r.user) && r.user.login !== author)
      const latest = new Map<string, string>()
      for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(r.user!.login!, r.state) // a plain comment does not replace an approval or a change request
      approvals.push([...latest.values()].filter(s => s === 'APPROVED').length)
      const inline = (fetch(`repos/{owner}/{repo}/pulls/${pr.number}/comments?per_page=100`) as GhComment[]).filter(c => human(c.user) && c.user.login !== author).length
      const talk = (fetch(`repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`) as GhComment[]).filter(c => human(c.user) && c.user.login !== author).length
      comments.push(inline + talk + reviews.filter(r => r.body?.trim()).length)
      const first = reviews.map(r => Date.parse(r.submitted_at ?? '')).filter(Number.isFinite).sort((a, b) => a - b)[0]
      if (first !== undefined && first >= Date.parse(pr.created_at)) waits.push((first - Date.parse(pr.created_at)) / 3_600_000)
    }
    const round = (o: { median: number; p95: number }): { median: number; p95: number } => ({ median: Math.round(o.median * 10) / 10, p95: Math.round(o.p95 * 10) / 10 })
    return { prs: pulls.length, approvals: stat(approvals), comments: stat(comments), waitHours: waits.length ? { ...round(stat(waits)), of: waits.length } : null, unreviewed: pulls.length - waits.length }
  } catch (e) {
    return { unavailable: `GitHub was not readable (${(e as Error).message.split('\n')[0]?.slice(0, 120)}); is gh installed and logged in?` }
  }
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[Math.floor((s.length - 1) / 2)] ?? 0) + ((s.length % 2 === 0 ? (s[s.length / 2] ?? 0) - (s[s.length / 2 - 1] ?? 0) : 0) / 2) : 0 }
const lines = (root: string, sha: string): number | null => {
  const stat = gitIn(root, ['diff', '--numstat', `${sha}^1`, sha, '--', '.', ':!.rig'])
  return stat === null ? null : stat.split('\n').filter(Boolean).reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((a, b) => a + (Number(b) || 0), 0), 0)
}

export function buildReport(root: string, since: string | null = null): Report {
  const merges = changeHistory(root).filter(m => !since || m.date >= since)
  const seen = new Set(merges.map(m => m.slug))
  const size = merges.map(m => lines(root, m.sha)).filter((n): n is number => n !== null)
  const reverted = merges.filter(m => m.reverted).length
  const tiers: Report['tiers'] = { '0': { merged: 0, reverted: 0 }, '1': { merged: 0, reverted: 0 }, '2': { merged: 0, reverted: 0 }, unknown: { merged: 0, reverted: 0 } }
  for (const m of merges) { const t = tiers[m.tier === null ? 'unknown' : String(m.tier) as '0']; t.merged++; if (m.reverted) t.reverted++ }
  const shipped = shippedChanges(root).filter(c => !since || seen.has(c.slug))
  const hours: number[] = []
  let measured = 0, clean = 0
  for (const { slug } of shipped) {
    const dir = path.join(root, '.rig', 'changes', slug)
    const runs = readJsonl<RunRow>(path.join(dir, 'evidence', 'runs.jsonl'))
    if (runs.length) { measured++; if (runs.every(r => (r.exit === 0 || r.expectFail) && !r.timedOut)) clean++ }
    const first = gitIn(root, ['log', '--reverse', '--format=%cI', '--', `.rig/changes/${slug}`])?.split('\n')[0]
    const approved = readJson<{ at?: string } | null>(path.join(dir, 'approval.json'), null)?.at ?? '' // no approval record: ''
    if (first && approved && Date.parse(approved) >= Date.parse(first)) hours.push((Date.parse(approved) - Date.parse(first)) / 3_600_000)
  }
  const slugs = new Set(shipped.map(c => c.slug))
  const all = readJsonl<{ slug: string; by?: string; at?: string }>(path.join(root, '.rig', 'waivers.jsonl'))
  const waivers = all.filter(w => slugs.has(w.slug)).length
  const ages = all.map(w => ageDays(w.at ?? ''))
  const classes = mineCandidates(root).map(c => ({ ...c, changes: c.changes.filter(s => slugs.has(s)) })).filter(c => c.changes.length >= 2)
  return {
    merged: merges.length, shipped: shipped.length, since,
    prLines: size.length ? { median: median(size), max: Math.max(...size) } : null,
    firstPass: { measured, clean }, reverted, tiers,
    hoursToApproval: hours.length ? { median: Math.round(median(hours) * 10) / 10, of: hours.length } : null,
    waiversPerChange: shipped.length ? Math.round((waivers / shipped.length) * 100) / 100 : 0,
    waiverRows: { unowned: all.filter(w => !w.by || w.by === 'unknown').length, oldestDays: ages.length ? Math.max(...ages) : null },
    repeat: { classes: classes.length, changes: new Set(classes.flatMap(c => c.changes)).size },
    unavailable: ['CI first-pass rate (the CI provider holds it)', 'review time and findings fixed without a person (not recorded anywhere in the repo)'],
  }
}

function humanTimeText(h: NonNullable<Report['humanTime']>): string[] {
  if ('unavailable' in h) return [`  human time (GitHub)        unavailable: ${h.unavailable}`]
  const two = (o: { median: number; p95: number }): string => `median ${o.median}, p95 ${o.p95}`
  return [`  human time (GitHub), ${h.prs} merged PR(s):`, `    approvals per PR         ${two(h.approvals)}`, `    human comments per PR    ${two(h.comments)}`,
    `    hours waiting on a person  ${h.waitHours ? `${two(h.waitHours)} (${h.waitHours.of} PR(s)); ${h.unreviewed} merged with no human review` : `n/a; ${h.unreviewed} merged with no human review`}`]
}

export function reportText(r: Report): string {
  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : 'n/a')
  return [
    `rig report${r.since ? ` since ${r.since}` : ''}: ${r.merged} merged change(s), ${r.shipped} with records in the tree`,
    `  lines changed per merge    ${r.prLines ? `median ${r.prLines.median}, max ${r.prLines.max}` : 'n/a'}`,
    `  first-pass runs            ${pct(r.firstPass.clean, r.firstPass.measured)} (${r.firstPass.clean} of ${r.firstPass.measured} changes with recorded runs)`,
    `  reverted                   ${r.reverted} of ${r.merged}`,
    `  by tier (merged/reverted)  ${(['0', '1', '2', 'unknown'] as const).map(k => `${k}: ${r.tiers[k].merged}/${r.tiers[k].reverted}`).join(', ')}`,
    `  hours, first commit to approval  ${r.hoursToApproval ? `median ${r.hoursToApproval.median} (${r.hoursToApproval.of} change(s))` : 'n/a'}`,
    `  waivers per change         ${r.waiversPerChange} (${r.waiverRows.unowned} with no owner; oldest ${r.waiverRows.oldestDays === null ? 'n/a' : (Number.isFinite(r.waiverRows.oldestDays) ? `${r.waiverRows.oldestDays} day(s)` : 'age unknown')})`,
    `  repeat mistakes            ${r.repeat.classes} class(es) across ${r.repeat.changes} of ${r.shipped} change(s)`,
    ...(r.humanTime ? humanTimeText(r.humanTime) : []),
    `not available here: ${r.unavailable.join('; ')}`,
  ].join('\n')
}

export function cmdReport(args: Args): void {
  const since = typeof args.opt.since === 'string' ? args.opt.since : null
  const r = buildReport(ROOT, since)
  if (args.opt.github) {
    r.humanTime = humanTime(ghFetch(ROOT), since, Math.max(1, Math.floor(Number(typeof args.opt.limit === 'string' ? args.opt.limit : 50)) || 50))
    if (!('unavailable' in r.humanTime)) r.unavailable = r.unavailable.map(u => u.startsWith('review time') ? 'findings fixed without a person (not recorded anywhere in the repo)' : u)
  }
  out(args.opt.json ? JSON.stringify(r) : reportText(r))
}
