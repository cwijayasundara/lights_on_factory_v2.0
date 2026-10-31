// The slim lifecycle (behavioural harness spec 2026-10-16 §8): a change is a folder under .rig/changes/<slug>/ and its
// status is which files it has. Only a person writes approval.json; verify writes verify.json for the tree it judged.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SENSORS_PATH, SDLC, CHANGES, read, readJson, exists, isTrunk, trunkName, sha, now, git, defaultBase, frontmatter, skillRef as k } from './core.ts'
import { openQuestions, normPath, globToRegex, planFiles, blastRadius, type Finding } from './model.ts'
import { parseRegistry, contractGlobs } from './registry.ts'
import { carriedIds } from './carry.ts'

export const TYPES = ['feature', 'bugfix', 'refactor', 'chore'] as const
type ChangeType = typeof TYPES[number]
export type Status = 'spec' | 'plan' | 'approve' | 'build' | 'pr' | 'review' | 'shipped'
export type Approval = { by: string; at: string; hashes: Record<string, string>; contracts: Record<string, string> }
type Verify = { at: string; from?: string; tree: string | null; base: string | null; pass: boolean; blocks: string[] }

const ACTIVE = path.join(SDLC, 'state', 'active')
const APPROVED = ['spec.md', 'plan.md']
// A charted change's copy of the PRD rows its intent cites: approved with it when present, never required (an ad-hoc change has none).
const OPTIONAL = ['requirements.md']
// Types earlier rig versions wrote, folded into the four the proof rules need.
const LEGACY: Record<string, ChangeType> = { greenfield: 'feature', incident: 'bugfix', migration: 'chore', spike: 'chore' }

export const changeDir = (slug: string): string => path.join(CHANGES, slug)
const file = (slug: string, name: string): string => path.join(CHANGES, slug, name)
// Trailing whitespace is left out: git's readers (the staged text at commit) return trimmed output.
export const digest = (text: string): string => sha(text.replace(/\s+$/, ''))

export function activeSlug(): string | null {
  const s = read(ACTIVE).trim()
  return s && exists(changeDir(s)) ? s : null
}
export function setActive(slug: string | null): void {
  fs.mkdirSync(path.dirname(ACTIVE), { recursive: true })
  if (slug) fs.writeFileSync(ACTIVE, `${slug}\n`)
  else fs.rmSync(ACTIVE, { force: true })
}

export const toType = (raw: string | undefined): ChangeType => ((TYPES as readonly string[]).includes(raw ?? '') ? (raw as ChangeType) : LEGACY[raw ?? ''] ?? 'feature')
export const changeType = (slug: string): ChangeType => toType(frontmatter(read(file(slug, 'intent.md'))).data.type)

export function newChange(slug: string, type: ChangeType, title: string, source?: string, full = false): void {
  fs.mkdirSync(changeDir(slug), { recursive: true })
  fs.writeFileSync(file(slug, 'intent.md'), `---\nslug: ${slug}\ntype: ${type}\n${source ? `source: ${source}\n` : ''}${full ? 'weight: full\n' : ''}---\n# ${title}\n\n## Intent\n\n## Open questions\nnone\n`)
  setActive(slug)
}

// Contract files frozen by an approval, hashed one by one so a later edit names the file (spec §6).
// The contract files under the registry's globs (spec §6), tracked or new.
export function contractFiles(): string[] {
  const globs = contractGlobs(parseRegistry(read(SENSORS_PATH)).registry.contracts)
  if (!globs.length) return []
  return (git(['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(f => f && globs.some(g => globToRegex(g).test(f))).sort()
}
export const freezeRecord = (): Record<string, string> => Object.fromEntries(contractFiles().filter(f => exists(path.join(ROOT, f))).map(f => [f, digest(read(path.join(ROOT, f)))]))
const hashes = (slug: string): Record<string, string> => Object.fromEntries([...APPROVED, ...OPTIONAL].filter(n => exists(file(slug, n))).map(n => [n, digest(read(file(slug, n)))]))
export const readApproval = (slug: string): Approval | null => readJson<Approval | null>(file(slug, 'approval.json'), null)
export function approvalState(slug: string): 'missing' | 'stale' | 'approved' {
  const a = readApproval(slug)
  if (!a?.hashes) return 'missing'
  return JSON.stringify(a.hashes) === JSON.stringify(hashes(slug)) ? 'approved' : 'stale'
}
// Why a person cannot approve yet, or null.
export function approvalRefusal(slug: string): string | null {
  const missing = APPROVED.filter(n => !exists(file(slug, n)))
  if (missing.length) return `nothing to approve yet: ${slug} has no ${missing.join(' or ')}`
  const open = APPROVED.flatMap(n => openQuestions(read(file(slug, n))).map(q => `${n}: ${q}`))
  if (open.length) return `resolve the open question(s) first: answer each, or record the default under ## Decisions, and leave "## Open questions" as none:\n${open.map(q => `  - ${q}`).join('\n')}`
  const source = frontmatter(read(file(slug, 'intent.md'))).data.source
  const unsettled = source ? carriedIds(path.join(ROOT, source)).filter(id => !new RegExp(`\\b${id}\\b`).test(read(file(slug, 'spec.md')))) : []
  if (unsettled.length) return `carried item(s) not settled in spec.md: ${unsettled.join(', ')} (put each in a behaviour or under ## Out of scope with the person's reason)`
  const radius = blastRadius(read(file(slug, 'spec.md')))
  const outside = radius ? outsideRadius(planFiles(read(file(slug, 'plan.md'))), radius) : []
  return outside.length ? `plan touches a file outside the blast radius: ${outside.join(', ')} (add it to spec.md ## Blast radius or drop it from plan.md ## Files)` : null
}
// Plan paths that neither equal a radius entry nor sit under a radius directory (an entry ending in /, or a bare directory path) or glob.
export function outsideRadius(planPaths: string[], radius: string[]): string[] {
  const entries = radius.map(normPath)
  const inside = (p: string): boolean => entries.some(r => r === p || p.startsWith(r.endsWith('/') ? r : `${r}/`) || (r.includes('*') && globToRegex(r).test(p)))
  return planPaths.map(normPath).filter(p => !inside(p))
}
// A file a change's plan lists, touched before a person approved the plan: the build ran ahead of the gate (shop_app cart-storage, 2026-10-27:
// red and green runs at 12:21-12:25, approval at 12:28). A plan changed since its approval is the ship-time plan-gate's, not this one.
export function unapprovedBuild(slugs: string[], touched: string[], planGate: boolean): Finding[] {
  if (!planGate) return []
  return slugs.flatMap(slug => {
    const plan = file(slug, 'plan.md')
    if (!exists(plan) || approvalState(slug) !== 'missing') return []
    const listed = planFiles(read(plan))
    return touched.filter(f => !f.startsWith('.rig/') && listed.length && !outsideRadius([f], listed).length).map(file => ({
      sensor: 'plan-gate', severity: 'block' as const, file,
      message: `${slug}: ${file} is in the plan but the plan is not approved; the build started before the person approved it`,
      fix: `stop: a person reviews spec.md and plan.md and runs ${k('approve')} ${slug}, then build`,
    }))
  })
}

export function writeApproval(slug: string, by: string): Approval {
  const a: Approval = { by, at: now(), hashes: hashes(slug), contracts: freezeRecord() }
  fs.writeFileSync(file(slug, 'approval.json'), JSON.stringify(a, null, 2) + '\n')
  return a
}

const readVerify = (slug: string): Verify | null => readJson<Verify | null>(file(slug, 'verify.json'), null)
export const writeVerify = (slug: string, v: Verify): void => fs.writeFileSync(file(slug, 'verify.json'), JSON.stringify(v, null, 2) + '\n')
export const verifyFresh = (slug: string, tree: string | null): boolean => { const v = readVerify(slug); return Boolean(v?.pass && tree && v.tree === tree) }

// Shipped: its pr.md is on the trunk (HEAD itself when the trunk is checked out, where defaultBase has nothing to compare).
// One ls-tree per process, however many changes status walks.
let shippedOnTrunk: Set<string> | null = null
export function isShipped(slug: string): boolean {
  if (!shippedOnTrunk) {
    const base = defaultBase() ?? (isTrunk(git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? '') ? 'HEAD' : null)
    const files = base ? (git(['ls-tree', '-r', '--name-only', base, '--', '.rig/changes']) ?? '').split('\n') : []
    shippedOnTrunk = new Set(files.filter(f => f.endsWith('/pr.md')).map(f => f.split('/')[2] ?? ''))
  }
  return shippedOnTrunk.has(slug)
}

export function status(slug: string, gates: { plan: boolean }, tree: string | null): Status {
  if (isShipped(slug)) return 'shipped'
  if (exists(file(slug, 'pr.md'))) return 'review'
  if (!exists(file(slug, 'spec.md'))) return 'spec'
  if (!exists(file(slug, 'plan.md'))) return 'plan'
  if (gates.plan && approvalState(slug) !== 'approved') return 'approve'
  return verifyFresh(slug, tree) ? 'pr' : 'build'
}

// pr.ts clears the active pointer after committing, so a change waiting on review would vanish from the journey (shop_app 2026-10-27).
export function awaitingReview(): string | null {
  // The newest PR first: an older one left open must not hide the change the person just shipped.
  const dirs = exists(CHANGES) ? fs.readdirSync(CHANGES).filter(s => exists(file(s, 'pr.md'))) : []
  return dirs.sort((a, b) => fs.statSync(file(b, 'pr.md')).mtimeMs - fs.statSync(file(a, 'pr.md')).mtimeMs).find(s => !isShipped(s)) ?? null
}
// No remote: pr.md says local-only and nobody can open a PR, so the person merges it themselves.
function reviewStep(slug: string): string {
  const pr = frontmatter(read(file(slug, 'pr.md'))).data
  return pr.state === 'local-only'
    ? `a person merges ${pr.branch || `sdlc/${slug}`} into ${trunkName()} locally, or adds a remote and pushes it: there is no remote, so no PR was opened`
    : 'a person reviews and merges the PR'
}
export const nextStep = (slug: string, s: Status): string => ({
  spec: `${k('start')} ${slug}`, plan: `${k('plan')} ${slug}`, approve: `a person reviews spec.md and plan.md, then runs ${k('approve')} ${slug}`,
  build: `${k('build')} ${slug}`, pr: `${k('pr')} ${slug}`, review: reviewStep(slug), shipped: 'done',
})[s]
