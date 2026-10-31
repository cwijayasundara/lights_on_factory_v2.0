// The scope check (harness readiness 1.3): a charted intent may say which paths its change may touch, and a diff outside them is a finding.
// Deterministic and free. The scope is read from the BASE branch at ship and CI, so a PR cannot widen its own scope by editing or deleting
// the intent; at edit and Stop it is read from the working tree, for quick feedback. A change whose slug has no product intent, or whose
// intent has no `scope:`, is simply not checked (`sdlc sensors` says so).
import path from 'node:path'
import { ROOT, read, fmList } from './core.ts'
import { matchesAny, isTest, type FileDiff, type Finding } from './model.ts'
import type { Paths } from './registry.ts'
import { intentRelOf } from './product.ts'

// readIntent: how to get the intent's text (the working tree, or the base ref); files: the repo's files at that ref, to find the intent's sprint folder (default: the working tree).
export function intentScope(slug: string, readIntent: (rel: string) => string = rel => read(path.join(ROOT, rel)), files?: string[]): { scope: string[]; touches: string[] } | null {
  const rel = intentRelOf(slug, files)
  if (!rel) return null
  const text = readIntent(rel)
  const scope = fmList(text, 'scope')
  return scope.length ? { scope, touches: fmList(text, 'touches') } : null
}

// A plain path (no wildcard) names the file or the directory under it.
const expand = (globs: string[]): string[] => globs.flatMap(g => (g.includes('*') ? [g] : [g, `${g}/**`]))
// Repo-root configuration (manifests, lockfiles, settings) and CI files are not product code; a pack's ignore globs name its docs and lockfiles.
const ROOT_CONFIG = /^[^/]+\.(json|toml|ya?ml|cfg|ini|txt|lock)$|^\.github\//

// Warn while the model works (edit, Stop), block when the change is judged (ship, CI), like the size limits.
export function scopeFindings(diffs: FileDiff[], slugs: string[], paths: Paths, point: 'edit' | 'stop' | 'ship' | 'ci', scopeOf: (slug: string) => ReturnType<typeof intentScope> = s => intentScope(s)): Finding[] {
  const scoped = slugs.flatMap(slug => { const s = scopeOf(slug); return s ? [{ slug, ...s }] : [] })
  if (!scoped.length) return []
  const allowed = expand([...new Set(scoped.flatMap(s => [...s.scope, ...s.touches]))]).concat(scoped.map(s => `.rig/changes/${s.slug}/**`))
  const outside = (f: string): boolean => !f.startsWith('.rig/') && !ROOT_CONFIG.test(f) && !matchesAny(f, allowed) && !matchesAny(f, paths.ignore) && !isTest(f, paths) && !matchesAny(f, paths.testSupport)
  // A rename is judged at both ends: moving a file out of scope, or in from outside it, is a change outside the scope either way.
  return diffs.filter(d => !d.binary && [d.file, ...(d.from ? [d.from] : [])].some(outside)).map(d => {
    const file = [d.file, d.from ?? ''].find(f => f && outside(f)) as string
    return {
      sensor: 'scope', severity: point === 'edit' || point === 'stop' ? 'warn' as const : 'block' as const, file,
      message: `${file} is outside the scope of ${scoped.map(s => s.slug).join(', ')} (scope: ${scoped.flatMap(s => s.scope).join(', ')})`,
      fix: 'put this change in its own intent, or name the path under `touches:` in the intent for deliberate cross-slice work (a person approves that change to the intent, on the base branch, first)',
    }
  })
}
