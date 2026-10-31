// `sdlc queue` (harness readiness, many instances, notes 2026-10-21): one view across every git worktree of this repo. Each instance of the model
// works in its own worktree, so a person's two stops (approve a plan, merge a PR) are a queue; this lists what waits on a person with the
// command to run, what is still the model's, and which in-flight plans touch the same file (a conflict at merge, found before the work is done).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, SLUG_RE, exists, read, out, fail, git, skillRef, type Args } from './core.ts'
import { planFiles, normPath } from './model.ts'
import { activeSlug, status } from './lifecycle.ts'
import { loadConfig } from './check.ts'
import { treeStamp } from './stamp.ts'
import { readyIntents, designDocOf } from './chart.ts'
import { intentRel } from './product.ts'
import { designIntents } from './chartcheck.ts'
import { readAutonomy, writeAutonomy } from './autonomy.ts'

type QueueRow = { worktree: string; branch: string; slug: string; status: string; next: string; person: boolean; files: string[] }
type Overlap = { file: string; changes: string[] }
// unreadable: worktrees that have a .rig whose status could not be read, so a clean answer would not cover them.
export type Queue = { rows: QueueRow[]; overlaps: Overlap[]; unreadable?: string[] }

const WAITS_ON_PERSON = ['approve', 'review']

export function worktrees(): { dir: string; branch: string }[] {
  const text = git(['worktree', 'list', '--porcelain']) ?? ''
  return text.split('\n\n').filter(Boolean).map(block => {
    const dir = /^worktree (.+)$/m.exec(block)?.[1] ?? ''
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? (/^detached/m.test(block) ? '(detached)' : '')
    return { dir, branch }
  }).filter(w => w.dir && fs.existsSync(path.join(w.dir, '.rig')))
}

// Two plans overlap on a file when one names it, or names a directory holding it (with or without a trailing slash).
const holds = (a: string, b: string): boolean => { const x = normPath(a).replace(/\/$/, ''), y = normPath(b).replace(/\/$/, ''); return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`) }
export function overlaps(rows: { slug: string; worktree: string; files: string[] }[]): Overlap[] {
  const found = new Map<string, Set<string>>()
  // By position, not by slug: two instances may both create a change with the same name.
  for (const [i, x] of rows.entries()) for (const y of rows.slice(i + 1)) {
    if (x.worktree === y.worktree) continue
    for (const f of x.files) for (const g of y.files) if (holds(f, g)) {
      const key = normPath(f).length >= normPath(g).length ? normPath(f) : normPath(g)
      found.set(key, (found.get(key) ?? new Set()).add(`${x.slug} (${path.basename(x.worktree)})`).add(`${y.slug} (${path.basename(y.worktree)})`))
    }
  }
  return [...found].map(([file, changes]) => ({ file, changes: [...changes].sort() })).sort((a, b) => a.file.localeCompare(b.file))
}

function buildQueue(): Queue {
  const rows: QueueRow[] = []
  const unreadable: string[] = []
  for (const w of worktrees()) {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1] ?? '', 'status', '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: w.dir } })
    let changes: { slug: string; status: string; next: string }[] = []
    try { changes = (JSON.parse(r.stdout) as { changes?: typeof changes }).changes ?? [] } catch { unreadable.push(w.dir); continue }
    for (const c of changes.filter(x => x.status !== 'shipped')) {
      rows.push({ worktree: w.dir, branch: w.branch, slug: c.slug, status: c.status, next: c.next, person: WAITS_ON_PERSON.includes(c.status), files: planFiles(read(path.join(w.dir, '.rig/changes', c.slug, 'plan.md'))) })
    }
  }
  return { rows, overlaps: overlaps(rows), unreadable }
}

// A command meant to be pasted into a shell: every path is single-quoted. The worktree's own vendored checker when it has one, else the script that ran this.
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const command = (r: QueueRow): string => {
  if (r.status !== 'approve') return `review the PR for ${r.slug} (branch sdlc/${r.slug}), then merge it`
  const script = fs.existsSync(path.join(r.worktree, '.rig/bin/sdlc.ts')) ? '.rig/bin/sdlc.ts' : quote(process.argv[1] ?? 'sdlc.ts')
  return `cd ${quote(r.worktree)} && SDLC_HUMAN=1 CLAUDE_PROJECT_DIR=${quote(r.worktree)} node --disable-warning=ExperimentalWarning ${script} approve ${r.slug}`
}

export function queueText(q: Queue): string {
  const wait = q.rows.filter(r => r.person), run = q.rows.filter(r => !r.person)
  const line = (r: QueueRow): string => `  ${r.slug.padEnd(24)} ${r.status.padEnd(8)} ${path.basename(r.worktree)}`
  return [
    wait.length ? `Waiting for you (${wait.length}):` : 'Waiting for you: nothing',
    ...wait.flatMap(r => [line(r), `    ${command(r)}`]),
    run.length ? `With the model (${run.length}):` : 'With the model: nothing',
    ...run.map(r => `${line(r)} next: ${r.next}`),
    ...(q.unreadable?.length ? [`Could not read ${q.unreadable.length} worktree(s), so they are not in this list: ${q.unreadable.join(', ')}`] : []),
    ...(q.overlaps.length ? [`Plans that touch the same file (${q.overlaps.length}): land one first, or split the work:`, ...q.overlaps.map(o => `  ${o.file}: ${o.changes.join(' and ')}`)] : []),
  ].join('\n')
}

// The files another instance's plan already holds that this change's plan also names (file claims, harness readiness 3.4): one writer per file.
export function conflictsFor(slug: string, q: Queue = buildQueue()): Overlap[] {
  return q.overlaps.filter(o => o.changes.some(c => c.startsWith(`${slug} (`)))
}

// The autonomy queue: the one intent the model may start next. Rung 0 leaves that to a person; a change in flight holds the queue until it waits only on a merge (status review) or ships.
export function queueNext(): { slug: string; sprint: number; path: string } | { none: string } {
  const a = readAutonomy()
  if (a.rung < 1) return { none: 'rung 0: a person starts each intent' }
  const active = activeSlug(), st = active ? status(active, loadConfig().registry.gates, treeStamp()) : null
  if (active && st !== 'review' && st !== 'shipped') return { none: `a change is active: ${active} (${st})` }
  const listed = new Map<number, string[]>()
  const order = (sprint: number): string[] => {
    if (!listed.has(sprint)) { const d = designDocOf(sprint); listed.set(sprint, d && exists(path.join(ROOT, d)) ? designIntents(read(path.join(ROOT, d))) : []) }
    return listed.get(sprint) ?? []
  }
  const rank = (r: { slug: string; sprint: number }): number => { const i = order(r.sprint).indexOf(r.slug); return i < 0 ? Number.MAX_SAFE_INTEGER : i }
  const [first] = readyIntents().sort((x, y) => Number(a.deferred.includes(x.slug)) - Number(a.deferred.includes(y.slug)) || x.sprint - y.sprint || rank(x) - rank(y) || x.slug.localeCompare(y.slug))
  return first ? { slug: first.slug, sprint: first.sprint, path: intentRel(first.sprint, first.slug) } : { none: 'no intents are ready' }
}

function cmdDefer(args: Args, on: boolean): void {
  if (process.env.SDLC_HUMAN !== '1') fail('deferring queue intents is human-only: the person runs queue defer <slug> or queue undefer <slug>', 3)
  const slug = args.pos[1]
  if (!slug || !SLUG_RE.test(slug)) fail(`usage: queue ${on ? 'defer' : 'undefer'} <slug>`)
  const a = readAutonomy()
  writeAutonomy({ ...a, deferred: on ? [...new Set([...a.deferred, slug])] : a.deferred.filter(d => d !== slug) })
  out(`${slug} is ${on ? 'deferred: it goes last in' : 'no longer deferred in'} the queue`)
}

export function cmdQueue(args: Args): void {
  if (args.pos[0] === 'defer' || args.pos[0] === 'undefer') return cmdDefer(args, args.pos[0] === 'defer')
  if (args.pos[0] === 'next') {
    const q = queueNext()
    return out(args.opt.json ? JSON.stringify(q) : 'slug' in q ? `start ${q.slug}: ${skillRef('start')} ${q.path} (rung ${readAutonomy().rung})` : `queue: ${q.none}`)
  }
  if (args.opt.check === true) fail('usage: queue --check <slug>')
  const check = typeof args.opt.check === 'string' ? args.opt.check : null
  if (check) {
    const q = buildQueue()
    const found = conflictsFor(check, q)
    const blind = q.unreadable?.length ? `\nwarning: could not read ${q.unreadable.length} worktree(s), so this check does not cover them: ${q.unreadable.join(', ')}` : ''
    out((found.length ? [`${check} names a file another in-flight plan already holds:`, ...found.map(o => `  ${o.file}: ${o.changes.join(' and ')}`), 'Land the other change first, or split the work so each file has one writer.'].join('\n') : `${check}: no other in-flight plan names the same files`) + blind)
    process.exitCode = found.length ? 1 : 0
    return
  }
  const q = buildQueue()
  out(args.opt.json ? JSON.stringify(q) : queueText(q))
}
