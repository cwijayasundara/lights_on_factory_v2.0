// The journey view (dashboard spec 2026-10-18): where a repo is in the AI SDLC and the one command to run next, computed from
// files only. The outer loop is a sprint (init, PRD, chart with its test plan, one approval, build); the inner loop is one change.
// `show` says which loops a person should see: a greenfield repo has both, a brownfield repo is entered through the outer loop.
import path from 'node:path'
import { ROOT, SENSORS_PATH, SDLC, CHANGES, exists, readJson, skillRef } from './core.ts'
import { activeSlug, awaitingReview, changeType, isShipped, nextStep, status, type Status } from './lifecycle.ts'
import { latestAgents } from './modelstate.ts'
import { readAutonomy } from './autonomy.ts'
import { queueNext } from './queue.ts'
import { chartState, readyIntents, sprintIntents, sprintsKnown } from './chart.ts'
import { testplanDir, prdHint, prdsInDocs, intentRel, prdPath } from './product.ts'

// The command a person types: /rig:<name> from the plugin, /rig-<name> (the skill's folder, never /rig:<name>) from a standalone copy.
const k = skillRef

type StepState = 'done' | 'current' | 'gate' | 'todo'
// `by` says who takes the step; `auto` marks the unattended run (build, test, fix, PR, advisory review) that one approval starts and no person gates until merge.
export type JourneyStep = { id: string; label: string; command: string; state: StepState; by: 'model' | 'person'; auto?: true; detail?: string }
export type Journey = {
  agents: { agent: string; model: string; at: string }[]
  initialised: boolean; kind: 'greenfield' | 'brownfield'; show: ('outer' | 'inner')[]; sprint: number | null
  outer: JourneyStep[]; inner: { slug: string; type: string; steps: JourneyStep[] } | null
  next: { command: string; by: 'model' | 'person'; why: string }; ready: string[]; rung: number; queue: string | null
}

// Brownfield is the repo init indexed (`wiki init` writes wiki.json); everything else entered empty.
// A wiki.json that `wiki sync` wrote at the end of a change (origin: sync) does not make the repo brownfield.
export const repoKind = (): 'greenfield' | 'brownfield' => {
  const file = path.join(SDLC, 'wiki.json')
  if (!exists(file)) return 'greenfield'
  return readJson<{ origin?: unknown } | null>(file, null)?.origin === 'sync' ? 'greenfield' : 'brownfield'
}

// The first step not done is where the person is; a step only a person can take is a gate.
function mark(steps: { id: string; label: string; command: string; done: boolean; detail?: string; gate?: boolean; person?: boolean; auto?: boolean }[]): JourneyStep[] {
  const at = steps.findIndex(s => !s.done)
  return steps.map((s, i): JourneyStep => ({ id: s.id, label: s.label, command: s.command, by: s.gate || s.person ? 'person' : 'model', ...(s.auto ? { auto: true as const } : {}), state: i < at || at < 0 ? 'done' : i === at ? (s.gate ? 'gate' : 'current') : 'todo', ...(s.detail ? { detail: s.detail } : {}) }))
}

// Inner loop: lifecycle.ts's status maps onto seven steps ('build' covers build and test: the verify stamp is what moves it on).
const INNER: Status[] = ['spec', 'plan', 'approve', 'build', 'pr', 'review', 'shipped']
function innerSteps(s: Status, gates: boolean, slug: string, reviewed: boolean): JourneyStep[] {
  const at = INNER.indexOf(s)
  const done = (i: number): boolean => at > i
  const rows = [
    { id: 'start', label: 'Start', command: `${k('start')} ${slug}`, done: done(0) }, { id: 'plan', label: 'Plan', command: `${k('plan')} ${slug}`, done: done(1) },
    { id: 'approve', label: gates ? 'Approve' : 'Approve (off)', command: `${k('approve')} ${slug}`, done: done(2) || !gates, gate: true },
    { id: 'build', label: 'Build', command: `${k('build')} ${slug}`, done: at > 3, auto: true }, { id: 'test', label: 'Test', command: `${k('test')} ${slug}`, done: at > 3, auto: true },
    { id: 'pr', label: 'PR', command: `${k('pr')} ${slug}`, done: done(4), auto: true },
    { id: 'review', label: 'Review', command: `review and its fixes (the ${k('pr')} reviewer)`, done: s === 'shipped' || (at >= 5 && reviewed), auto: true }, { id: 'merge', label: 'Merge', command: 'review and merge the PR', done: s === 'shipped', gate: true },
  ]
  return mark(rows)
}

export function journey(i: { gates: { plan: boolean }; tree: string | null }): Journey {
  const kind = repoKind(), show: ('outer' | 'inner')[] = kind === 'greenfield' ? ['outer', 'inner'] : ['outer']
  const initialised = exists(SENSORS_PATH)
  const sprints = sprintsKnown()
  const open = sprints.find(n => { const s = sprintIntents(n); return !exists(prdPath(n)) || !s.length || s.some(x => !isShipped(x)) })
  const docs = prdsInDocs()
  const n = open ?? (sprints.length ? (sprints[sprints.length - 1] as number) + 1 : docs[0]?.n ?? 0)
  const hint = (m: number): string => docs.find(d => d.n === m)?.rel ?? prdHint(m)
  const slugs = sprintIntents(n), shipped = slugs.filter(isShipped).length
  const cases = exists(path.join(testplanDir(n), 'cases.md'))
  const approved = slugs.length > 0 && chartState(n).state === 'approved'
  const ready = readyIntents().map(r => r.slug)
  const outer = mark([
    { id: 'init', label: 'Init', command: k('init'), done: initialised },
    { id: 'prd', label: 'PRD', command: `add PRD → ${hint(n)}`, person: true, done: exists(prdPath(n)) || exists(path.join(ROOT, hint(n))), detail: `sprint ${n}` },
    { id: 'chart', label: 'Chart', command: `${k('chart')} ${n}`, done: slugs.length > 0, detail: slugs.length ? `${slugs.length} intents` : undefined },
    // The chart writes the test plan itself (its QA step): a separate step only when a chart ended without cases.md.
    ...(slugs.length && !cases ? [{ id: 'testplan', label: 'Test plan', command: `${k('testplan')} ${n}`, done: false }] : []),
    { id: 'approve', label: 'Approve', command: `${k('approve')} chart-${n}`, done: approved, gate: true },
    { id: 'build', label: 'Build', command: `${k('start')} <intent>`, done: slugs.length > 0 && shipped === slugs.length, detail: slugs.length ? `${shipped}/${slugs.length} shipped` : undefined },
  ])
  const pick = queueNext(), queue = 'slug' in pick ? pick.slug : null
  const active = activeSlug()
  const act = active && !isShipped(active) ? active : awaitingReview()
  const st = act ? status(act, i.gates, i.tree) : null
  const outerNext = ((): Journey['next'] => {
    if (!initialised) return { command: k('init'), by: 'model', why: 'set this repo up for rig' }
    if (!exists(prdPath(n)) && !exists(path.join(ROOT, hint(n)))) return { command: `add the PRD at ${hint(n)}, then ${k('chart')} ${n} @${hint(n)}`, by: 'person', why: 'the sprint starts from your PRD, in any format and from any path' }
    if (!slugs.length) return { command: exists(prdPath(n)) ? `${k('chart')} ${n}` : `${k('chart')} ${n} @${hint(n)}`, by: 'model', why: 'turn the PRD into traced intents, architecture, ADRs and the test plan' }
    if (!cases) return { command: `${k('testplan')} ${n}`, by: 'model', why: 'write the test plan and cases for the sprint' }
    if (!approved) return { command: `${k('approve')} chart-${n}`, by: 'person', why: 'review the chart branch (a converted PRD: prd.md beside source.md first), then approve the sprint once' }
    if (ready[0]) return { command: `${k('start')} ${intentRel(n, ready[0] as string)}`, by: 'model', why: `${ready.length} intent(s) ready to build` }
    return shipped === slugs.length ? { command: exists(path.join(ROOT, hint(n + 1))) ? `${k('chart')} ${n + 1} @${hint(n + 1)}` : `add the PRD at ${hint(n + 1)}, then ${k('chart')} ${n + 1} @${hint(n + 1)}`, by: 'person', why: `sprint ${n} is shipped` } : { command: 'a change in flight must ship first', by: 'person', why: 'the remaining intents wait on their dependencies' }
  })()
  const next: Journey['next'] = act && st ? { command: nextStep(act, st), by: st === 'approve' || st === 'review' ? 'person' : 'model', why: `change ${act}` } : outerNext
  return { agents: latestAgents(path.join(SDLC, 'state', 'model.json')), initialised, kind, show, sprint: initialised ? n : null, outer, inner: act && st ? { slug: act, type: changeType(act), steps: innerSteps(st, i.gates.plan, act, exists(path.join(CHANGES, act, 'review.md'))) } : null, next, ready, rung: readAutonomy().rung, queue }
}

// The steps whose detail is drawn on the rail: the intent count and the build count.
export const RAIL_DETAIL = new Set(['chart', 'build'])
export function journeyText(j: Journey): string {
  const row = (steps: JourneyStep[]): string => steps.map(s => `${{ done: '✓', current: '●', gate: '◆', todo: '○' }[s.state]}${s.auto ? '⟳' : ''} ${s.command}${s.detail && RAIL_DETAIL.has(s.id) ? ` (${s.detail})` : ''}`).join('  ')
  return [
    ...(j.show.includes('outer') ? [`sprint ${j.sprint ?? '-'}  ${row(j.outer)}`] : []),
    ...(j.show.includes('inner') && j.inner ? [`change ${j.inner.slug}  ${row(j.inner.steps)}`] : []),
    `rung ${j.rung} · queue: ${j.queue ?? 'none'}`,
    `next: ${j.next.command}${j.next.by === 'person' ? '  (a person)' : ''}`,
  ].join('\n')
}
