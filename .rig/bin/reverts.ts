// Shipped changes, the tier each shipped at, and whether it was reverted (proposal 2026-10-27 C1, C2, Decision 3). Git alone, so the
// report stays network-free; CI adds the numbers of merged PRs labelled `revert`. The breaker reads only tier-0 merges.
import { gitIn } from './core.ts'

export type ChangeRow = { slug: string; sha: string; date: string; tier: 0 | 1 | 2 | null; reverted: boolean }

const PR_MD = ':(glob).rig/changes/*/pr.md'

// `git log` blocks: a NUL, then "<sha> <date or subject>", then the names the commit touched.
const blocks = (text: string | null): { head: string; files: string[] }[] =>
  (text ?? '').split('\0').filter(Boolean).map(b => { const [head = '', ...files] = b.split('\n').filter(Boolean); return { head, files } })

const tierOf = (root: string, sha: string, slug: string): ChangeRow['tier'] => {
  const m = /^## Risk\s*\n\s*\nTier ([0-2])\b/m.exec(gitIn(root, ['show', `${sha}:.rig/changes/${slug}/pr-body.md`]) ?? '')
  return m ? (Number(m[1]) as 0 | 1 | 2) : null
}

// `ref`: whose history to read; CI passes the base so a PR cannot add merges of its own to dilute the revert rate.
// `every`: one row per merge (the breaker: a change reverted and landed again keeps its revert); else one per change, as it lands now (the report).
export function changeHistory(root: string, revertPrs: number[] = [], ref = 'HEAD', every = false): ChangeRow[] {
  const order = (gitIn(root, ['log', ref, '--first-parent', '--format=%H']) ?? '').split('\n').filter(Boolean).reverse()
  const at = new Map(order.map((sha, n) => [sha, n]))
  const seen = new Set<string>()
  const added = blocks(gitIn(root, ['log', ref, '--first-parent', '--diff-filter=A', '--name-only', '--format=%x00%H %cs', '--', PR_MD]))
    .flatMap(({ head, files }) => { const [sha = '', date = ''] = head.split(' '); return files.map(f => ({ sha, date, slug: f.split('/')[2] ?? '' })) })
    .filter(m => m.sha && m.slug && (every || (!seen.has(m.slug) && seen.add(m.slug))))
    .reverse()
  const log = gitIn(root, ['log', ref, '--format=%B']) ?? ''
  // A merged revert-labelled PR (a merge commit "Merge pull request #N", or a squash "Title (#N)") that deleted a change's pr.md reverts the add before it.
  const pr = (subject: string): number => Number(/ Merge pull request #(\d+)\b/.exec(subject)?.[1] ?? /\(#(\d+)\)\s*$/.exec(subject)?.[1] ?? NaN)
  const deletions = blocks(gitIn(root, ['log', ref, '--first-parent', '--diff-filter=D', '--name-only', '--format=%x00%H %s', '--', PR_MD]))
    .filter(({ head }) => revertPrs.includes(pr(head)))
    .flatMap(({ head, files }) => files.map(f => ({ slug: f.split('/')[2] ?? '', n: at.get(head.split(' ')[0] ?? '') ?? -1 })))
  return added.map((m, i) => {
    const next = added.slice(i + 1).find(o => o.slug === m.slug)
    const from = at.get(m.sha) ?? -1, to = next ? (at.get(next.sha) ?? Infinity) : Infinity
    const labelled = deletions.some(d => d.slug === m.slug && d.n > from && d.n < to)
    return { ...m, tier: tierOf(root, m.sha, m.slug), reverted: log.includes(`This reverts commit ${m.sha}`) || labelled }
  })
}

export function breaker(rows: ChangeRow[], window: number, maxRate: number): string | null {
  const last = rows.filter(r => r.tier === 0).slice(-window)
  const reverted = last.filter(r => r.reverted).length
  return last.length && reverted / last.length > maxRate ? `tier-0 merges reverted: ${reverted} of ${last.length} in the last ${window} (over the risk.maxRevertRate of ${maxRate})` : null
}
