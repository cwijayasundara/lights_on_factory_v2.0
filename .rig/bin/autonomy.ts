// The autonomy rung: how far the autonomy queue may run without a person (0 none, 1 stops at approve, 2 also opens PRs, 3 also lets
// rig-check pass a tier-0 PR by a trusted author with no person, while risk.enforce is on and the revert breaker holds). Rung 3 is never proposed.
// A person sets it; the repo's own record of shipped changes only proposes a move. Zero dependencies.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, SLUG_RE, exists, read, readJson, now, out, fail, ownerOrFail, skillRef, type Args } from './core.ts'
import { shippedChanges, mineCandidates, waiversOf, findingsSection } from './learnmine.ts'
import { parseRegistry } from './registry.ts'

export type Autonomy = { rung: 0 | 1 | 2 | 3; since: string; deferred: string[]; history: { at: string; by: string; from: number; to: number; why: string }[] }

const EMPTY = (): Autonomy => ({ rung: 0, since: '', deferred: [], history: [] })
const CLEAN_SHIPS = 3
const BLOCKING = /\[category: (?:security|contract|design|unmapped)\]/

const fileOf = (root: string): string => path.join(root, '.rig', 'autonomy.json')

function load(root: string): { a: Autonomy; malformed: boolean } {
  const file = fileOf(root)
  if (!exists(file)) return { a: EMPTY(), malformed: false }
  try {
    const j = JSON.parse(read(file)) as Partial<Autonomy>
    if (j.rung !== 0 && j.rung !== 1 && j.rung !== 2 && j.rung !== 3) return { a: EMPTY(), malformed: true }
    return {
      a: {
        rung: j.rung, since: typeof j.since === 'string' ? j.since : '',
        deferred: Array.isArray(j.deferred) ? j.deferred.filter((d): d is string => typeof d === 'string') : [],
        history: Array.isArray(j.history) ? j.history : [],
      },
      malformed: false,
    }
  } catch { return { a: EMPTY(), malformed: true } }
}

export const readAutonomy = (root = ROOT): Autonomy => load(root).a

export function writeAutonomy(a: Autonomy, root = ROOT): void {
  fs.mkdirSync(path.join(root, '.rig'), { recursive: true })
  fs.writeFileSync(fileOf(root), `${JSON.stringify(a, null, 2)}\n`)
}

// A new repo starts at rung 1; an existing file (any rung) is never touched.
export function initAutonomy(root = ROOT): void {
  if (exists(fileOf(root))) return
  writeAutonomy({ rung: 1, since: now(), deferred: [], history: [] }, root)
}

function setRung(to: Autonomy['rung'], why: string, by: string, root = ROOT): Autonomy {
  const a = readAutonomy(root)
  const at = now()
  const next: Autonomy = { ...a, rung: to, since: at, history: [...a.history, { at, by, from: a.rung, to, why }] }
  writeAutonomy(next, root)
  return next
}

// The 3 newest shipped changes decide. Down wins over up. This only reads: the person decides.
export function proposeRung(root = ROOT): { to: number; why: string } | null {
  const { rung } = readAutonomy(root)
  const ships = shippedChanges(root)
  const waivers = waiversOf(root)
  const newest = ships.at(-1)
  if (rung > 0) {
    if (newest && waivers.some(w => w.slug === newest.slug)) return { to: rung - 1, why: `waived block in ${newest.slug}` }
    const repeated = mineCandidates(root)[0]
    if (repeated) return { to: rung - 1, why: `repeated finding: ${repeated.key}` }
  }
  if (rung >= 2) return null
  const last = ships.slice(-CLEAN_SHIPS)
  const clean = (slug: string): boolean => {
    const dir = path.join(root, '.rig', 'changes', slug)
    if (readJson<{ pass?: unknown } | null>(path.join(dir, 'verify.json'), null)?.pass !== true) return false
    const review = read(path.join(dir, 'review.md'))
    const section = findingsSection(review)
    return !section.split('\n').some(l => BLOCKING.test(l)) && !waivers.some(w => w.slug === slug)
  }
  if (last.length === CLEAN_SHIPS && last.every(s => SLUG_RE.test(s.slug) && clean(s.slug))) return { to: rung + 1, why: `${CLEAN_SHIPS} clean ships: ${last.map(s => s.slug).join(', ')}` }
  return null
}

function autonomyText(a: Autonomy, p: ReturnType<typeof proposeRung>, malformed = false): string {
  const lines = [`autonomy rung ${a.rung}${a.since ? ` since ${a.since}` : ''}${malformed ? ' (malformed .rig/autonomy.json: read as rung 0; fix it with `autonomy set <0|1|2|3> --why "<text>"`)' : ''}`]
  if (a.rung === 3) lines.push('rung 3: rig-check also lets a tier-0 PR by a trusted author merge without a person, while risk.enforce is on and the revert breaker holds')
  if (a.deferred.length) lines.push(`deferred: ${a.deferred.join(', ')}`)
  lines.push(p ? `proposal: move to rung ${p.to} (${p.why}); a person runs: autonomy set ${p.to} --why "${p.why}"` : 'proposal: none')
  return lines.join('\n')
}

export function cmdAutonomy(args: Args): void {
  if (args.pos[0] === 'set') {
    if (process.env.SDLC_HUMAN !== '1') fail(`the autonomy rung is human-only: the person runs ${skillRef('autonomy')} set <0|1|2|3> --why "<text>"`, 3)
    const to = Number(args.pos[1])
    const why = typeof args.opt.why === 'string' ? args.opt.why.trim() : ''
    if (![0, 1, 2, 3].includes(to) || !why) fail('usage: autonomy set <0|1|2|3> --why "<text>"')
    if (to === 3) {
      // Rung 3 lets a tier-0 PR merge with no person; it means nothing until rig-check enforces approvals and someone is trusted to author such PRs.
      const reg = parseRegistry(read(path.join(SDLC, 'sensors.json'))).registry
      const missing = [reg.risk.enforce ? '' : 'risk.enforce is off (run: sdlc.ts init --enforce)', reg.humanApproval.trusted.length ? '' : 'humanApproval.trusted is empty (list the GitHub logins whose tier-0 PRs may merge unattended in .rig/sensors.json)'].filter(Boolean)
      if (missing.length) fail(`rung 3 needs both first: ${missing.join('; ')}`)
    }
    const by = ownerOrFail(args, 'autonomy changes')
    const a = setRung(to as Autonomy['rung'], why, by)
    return out(`autonomy rung is now ${a.rung} (set by ${by}): ${why}`)
  }
  const { a, malformed } = load(ROOT)
  const p = proposeRung()
  out(args.opt.json ? JSON.stringify({ ...a, malformed, proposal: p }) : autonomyText(a, p, malformed))
}
