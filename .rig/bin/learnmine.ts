// Mining committed evidence for the learning loop (design 2026-10-17): review findings (the /rig:pr reviewer and its security pass) under ## Findings in review.md and waivers. Zero tokens.
// Only a key seen in at least two distinct changes is a candidate; one occurrence is never a lesson.
import path from 'node:path'
import { read, readJsonl, gitIn, listChanges, skillRef, type Waiver } from './core.ts'
import { escapeRe } from './model.ts'
import type { Lesson } from './learnfile.ts'

type Candidate = { key: string; kind: 'finding' | 'waiver'; changes: string[]; count: number; sample: string; rung: Rung['rung']; how: string }

// The promotion ladder (harness readiness 1.2): the strongest fix that fits a recurring mistake, strongest first. A person applies it; the
// table is data, keyed on the review category (a waiver has no category, so it is a lesson until a person says otherwise).
export type Rung = { rung: 'architecture' | 'ratchet' | 'test' | 'rule' | 'lesson'; how: string }
const ARCH: Rung = { rung: 'architecture', how: `make the bad dependency impossible: declare the layer edge under ## Layers in architecture.md (${skillRef('arch')}), then \`learn replay --layers .rig/learn/layers-<id>.md --earned <a>,<b>\`` }
const RATCHET: Rung = { rung: 'ratchet', how: 'a count that may only fall: a command sensor with "ratchet": "down" in .rig/sensors.json (duplication share, lint warnings)' }
const TEST: Rung = { rung: 'test', how: 'pin it with a test, or a frozen contract example, that fails without the fix' }
const RULE: Rung = { rung: 'rule', how: 'a pattern over added lines in .rig/rules.json, proven with `learn replay .rig/learn/rule-<id>.json --earned <a>,<b>`' }
const LESSON: Rung = { rung: 'lesson', how: 'one line of .rig/lessons.md; nothing mechanical catches it yet' }
const LADDER: Record<string, Rung> = { coupling: ARCH, responsibility: ARCH, abstraction: ARCH, duplication: RATCHET, tests: TEST, contract: TEST, design: ARCH, data: TEST, correctness: RULE, security: RULE }
// A waiver recurring on the layering sensor is the same mistake as a coupling finding; the other sensors have no stronger fix than a lesson.
const WAIVER_LADDER: Record<string, Rung> = { layering: ARCH }
export const ladderFor = (kind: Candidate['kind'], key: string): Rung => (kind === 'finding' ? LADDER[key] ?? LESSON : WAIVER_LADDER[key] ?? LESSON)
export type Shipped = { slug: string; date: string; keys: string[] }

const MIN_CHANGES = 2
const STALE_AFTER = 10
const WAIVED_AFTER = 3
const CATEGORY = /\[category: ([a-z-]+)\]/g

const changesDir = (root: string): string => path.join(root, '.rig', 'changes')
const reviewOf = (root: string, slug: string): string => read(path.join(changesDir(root), slug, 'review.md'))
export const waiversOf = (root: string): Waiver[] => readJsonl<Waiver>(path.join(root, '.rig', 'waivers.jsonl')).filter(w => typeof w.slug === 'string' && typeof w.sensor === 'string')

// Each finding line of a review, keyed by its category. Only the ## Findings section counts: a tagged line pasted under ## Dismissed or
// ## Deferred is not a kept finding. A review with no such heading is read whole.
export const findingsSection = (review: string): string => /^## Findings[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(review)?.[1] ?? review
const findingsOf = (review: string): { key: string; line: string }[] =>
  findingsSection(review).split('\n').flatMap(line => [...line.matchAll(CATEGORY)].map(m => ({ key: m[1] as string, line: line.replace(/^-\s*/, '').trim() })))

// Only shipped changes count: an in-flight change's review.md is not evidence yet, and replay and lesson status see only shipped ones.
export function mineCandidates(root: string): Candidate[] {
  const slugs = shippedChanges(root).map(s => s.slug)
  const acc = new Map<string, Candidate>()
  const add = (kind: Candidate['kind'], key: string, slug: string, sample: string): void => {
    const id = `${kind}:${key}`
    const c = acc.get(id) ?? { key, kind, changes: [], count: 0, sample, ...ladderFor(kind, key) }
    c.count++
    if (!c.changes.includes(slug)) c.changes.push(slug)
    acc.set(id, c)
  }
  for (const slug of slugs) for (const f of findingsOf(reviewOf(root, slug))) add('finding', f.key, slug, f.line)
  for (const w of waiversOf(root)) if (slugs.includes(w.slug)) add('waiver', w.sensor, w.slug, w.reason ?? '')
  return [...acc.values()].filter(c => c.changes.length >= MIN_CHANGES).sort((a, b) => b.changes.length - a.changes.length || a.key.localeCompare(b.key))
}

// A shipped change is dated by the commit that added its pr.md. One whose pr.md was never committed (unmerged, shallow clone) is left out.
export function shippedChanges(root: string): Shipped[] {
  const waivers = waiversOf(root)
  const out: Shipped[] = []
  for (const slug of listChanges(root)) {
    const log = gitIn(root, ['log', '--diff-filter=A', '--format=%cI', '--', `.rig/changes/${slug}/pr.md`])
    const date = log?.split('\n').filter(Boolean).pop()?.slice(0, 10)
    if (!date) continue
    const keys = [...new Set([...findingsOf(reviewOf(root, slug)).map(f => f.key), ...waivers.filter(w => w.slug === slug).map(w => w.sensor)])]
    out.push({ slug, date, keys })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug))
}

// When each lesson last fired (a later change carrying its key), and which lessons to propose retiring.
// A rule's waiver is told apart only by the rule id in the waiver's reason, because waivers record the sensor (`rules`), not the rule.
export function lessonStatus(lessons: Lesson[], shipped: Shipped[], waivers: { sensor: string; reason?: string }[]): { lastFired: Record<string, string>; retire: { id: string; why: string }[] } {
  const lastFired: Record<string, string> = {}
  const retire: { id: string; why: string }[] = []
  for (const l of lessons) {
    const fired = shipped.filter(s => s.date >= l.first && !l.seen.includes(s.slug) && s.keys.includes(l.key)).map(s => s.date).sort().pop()
    lastFired[l.id] = fired && fired > l.lastFired ? fired : l.lastFired
    if (l.status === 'active') {
      const later = shipped.filter(s => !l.seen.includes(s.slug) && (s.date > (lastFired[l.id] as string) || (s.date === lastFired[l.id] && !s.keys.includes(l.key)))).length
      if (later >= STALE_AFTER) retire.push({ id: l.id, why: `not fired in ${later} later changes` })
    } else if (l.status.startsWith('promoted:')) {
      const rule = l.status.slice('promoted:'.length)
      const named = new RegExp(`(?<![\\w-])${escapeRe(rule)}(?![\\w-])`)
      const waived = waivers.filter(w => w.sensor === 'rules' && named.test(w.reason ?? '')).length
      if (waived >= WAIVED_AFTER) retire.push({ id: l.id, why: `rule ${rule} waived ${waived} times` })
    }
  }
  return { lastFired, retire }
}
