// Where the product's files live. What belongs to one sprint sits under `.rig/product/sprints/sprint-<N>/` (its PRD, intents,
// test plan, chart review and approval), so two teams charting different sprints touch different folders. What every sprint
// edits stays at `.rig/product/`: brief.md, architecture.md and adr/. Paths here are the only place that layout is written down.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, exists } from './core.ts'

export const PRODUCT = path.join(SDLC, 'product')
export const ARCH_REL = '.rig/product/architecture.md'
export const archPath = path.join(PRODUCT, 'architecture.md')
const SPRINTS = path.join(PRODUCT, 'sprints')
const SPRINT_DIR_RE = /^sprint-(\d{1,4})$/

export const sprintDir = (n: number): string => path.join(SPRINTS, `sprint-${n}`)
export const prdPath = (n: number): string => path.join(sprintDir(n), 'prd.md')
export const intentsDir = (n: number): string => path.join(sprintDir(n), 'intents')
export const testplanDir = (n: number): string => path.join(sprintDir(n), 'testplan')
export const planPath = (n: number): string => path.join(sprintDir(n), 'plan.md')
export const implPlanPath = (n: number): string => path.join(sprintDir(n), 'implementation-plan.md')
export const approvalPath = (n: number): string => path.join(sprintDir(n), 'approval.json')
export const sourcePath = (n: number): string => path.join(sprintDir(n), 'source.md')
export const conversionPath = (n: number): string => path.join(sprintDir(n), 'conversion.md')
export const conversionReviewPath = (n: number): string => path.join(sprintDir(n), 'conversion-review.md')
export const ledgerPath = (n: number): string => path.join(sprintDir(n), 'requirements.md')
export const waiversPath = (n: number): string => path.join(sprintDir(n), 'waivers.json')
export const reviewPath = (n: number): string => path.join(sprintDir(n), 'chart-review.md')

// Repo-relative posix forms, for messages and for matching git paths.
export const sprintRel = (n: number): string => `.rig/product/sprints/sprint-${n}`
export const prdRel = (n: number): string => `${sprintRel(n)}/prd.md`
// Where a person puts a PRD: a repo-owned folder per sprint, mockups beside it; /rig:chart copies it to prdRel(n) (2026-10-26 tester).
export const prdHint = (n: number): string => `docs/prd/sprint-${n}/prd.md`
// A PRD the person already wrote under docs/prd/: sprint-<n>/prd.md, or the older flat sprint-<n>.md or sprint-<n>-<title>.md,
// lowest sprint first and the folder before a flat file of the same sprint, so the journey names it instead of asking for one
// (2026-10-25 shop_app: the PRDs were sprint-1-cart-add-remove.md and sprint-2-cart-get-items.md).
export function prdsInDocs(): { n: number; rel: string }[] {
  const dir = path.join(ROOT, 'docs', 'prd')
  if (!exists(dir)) return []
  return fs.readdirSync(dir).flatMap(f => {
    const m = /^sprint-(\d{1,4})(?:-[\w.-]+?)?(\.md)?$/.exec(f), st = m?.[1] ? fs.statSync(path.join(dir, f), { throwIfNoEntry: false }) : undefined // follows symlinks
    if (!m?.[1] || !st) return []
    if (st.isDirectory() && !m[2]) return exists(path.join(dir, f, 'prd.md')) ? [{ n: Number(m[1]), rel: `docs/prd/${f}/prd.md`, folder: 0 }] : []
    return st.isFile() && m[2] ? [{ n: Number(m[1]), rel: `docs/prd/${f}`, folder: 1 }] : []
  }).sort((a, b) => a.n - b.n || a.folder - b.folder || a.rel.localeCompare(b.rel)).map(({ n, rel }) => ({ n, rel }))
}
export const intentRel = (n: number, slug: string): string => `${sprintRel(n)}/intents/${slug}.md`

export function sprintsOnDisk(): number[] {
  if (!exists(SPRINTS)) return []
  return fs.readdirSync(SPRINTS, { withFileTypes: true }).flatMap(e => { const m = e.isDirectory() ? SPRINT_DIR_RE.exec(e.name) : null; return m?.[1] ? [Number(m[1])] : [] }).sort((a, b) => a - b)
}

// The repo-relative path of an intent by slug, from a list of repo-relative files (the working tree by default, a git tree at a base ref for the scope check).
export function intentRelOf(slug: string, files: string[] = sprintsOnDisk().flatMap(n => (exists(intentsDir(n)) ? fs.readdirSync(intentsDir(n)).map(f => `${sprintRel(n)}/intents/${f}`) : []))): string | null {
  return files.find(f => new RegExp(`^\\.rig/product/sprints/sprint-\\d{1,4}/intents/${slug.replace(/[^\w-]/g, '')}\\.md$`).test(f)) ?? null
}
