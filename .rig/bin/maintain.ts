// `sdlc maintain` (harness readiness 3.1): the garden. Deterministic scans for what accumulates when agents write code: duplicated blocks, source
// files nothing else mentions, and docs that cite paths that no longer exist. Each finding becomes a proposed intent under .rig/maintain/proposals/
// for a person to approve and start; nothing is edited. No tool and no model: it reads git's file list. Capped per run, and a finding is proposed once.
// Run it on a schedule (a native routine, /loop or cron): `node .rig/bin/sdlc.ts maintain`.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SENSORS_PATH, SDLC, out, fail, read, git, sha, writeAtomic, skillRef, type Args } from './core.ts'
import { parseRegistry } from './registry.ts'
import { isTest } from './model.ts'

const SOURCE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift)$/
const ENTRY = /^(index|main|app|mod|__init__|__main__|setup|conftest|server|cli|manage|program|lib)$/
const WINDOW = 6
const MIN_SHARED = 8 // shared windows between two files: about 13 duplicated lines
const MAX_BYTES = 400_000
const DEFAULT_CAP = 5
const BOILERPLATE_FILES = 6 // a window shared by more files than this is boilerplate (license headers, imports), not a duplicate worth proposing
// Not scanned: generated or vendored trees, rig's own files (its proposals would cite the paths they report), history and decision records
// that cite deleted paths on purpose, lockfiles and minified bundles.
const SKIP = /^(\.rig\/|dist\/|build\/|vendor\/|node_modules\/|docs\/(adr|decisions|research|proposals|superpowers)\/)|(^|\/)CHANGELOG|\.min\.js$|\.lock$|package-lock\.json$/
// Loaded by convention, not by name: migrations and anything numbered in sequence.
const BY_CONVENTION = /(^|\/)(migrations?|migrate|versions|alembic)\/|(^|\/)\d+[_-][^/]*$/
const GENERATED_CITES = /^(dist|build|\.rig|node_modules|vendor)\//

export type Finding = { kind: 'duplicate' | 'dead' | 'drift'; key: string; title: string; files: string[]; evidence: string }

const norm = (l: string): string => l.trim()
const meaningful = (l: string): boolean => l.length > 3 && !/^(\/\/|#|\*|\/\*|\*\/|--)/.test(l)

export function scan(files: Record<string, string>, isTestFile: (f: string) => boolean): Finding[] {
  const found: Finding[] = []
  files = Object.fromEntries(Object.entries(files).filter(([f]) => !SKIP.test(f)))
  const src = Object.keys(files).filter(f => SOURCE.test(f) && !isTestFile(f)).sort()
  // duplicates: every run of WINDOW meaningful lines, by hash; files that share enough windows
  const seen = new Map<string, { file: string; at: number }[]>()
  for (const f of src) {
    const lines = (files[f] ?? '').split('\n').map((l, i) => ({ l: norm(l), i: i + 1 })).filter(x => meaningful(x.l))
    for (let k = 0; k + WINDOW <= lines.length; k++) {
      const h = lines.slice(k, k + WINDOW).map(x => x.l).join('\n')
      const at = seen.get(h)
      if (at) at.push({ file: f, at: lines[k]!.i })
      else seen.set(h, [{ file: f, at: lines[k]!.i }])
    }
  }
  const pairs = new Map<string, { shared: number; at: number; other: number }>()
  for (const spots of seen.values()) {
    const byFile = [...new Map(spots.map(s => [s.file, s])).values()]
    if (byFile.length > BOILERPLATE_FILES) continue
    for (const a of byFile) for (const b of byFile) if (a.file < b.file) { const p = pairs.get(`${a.file}|${b.file}`); pairs.set(`${a.file}|${b.file}`, { shared: (p?.shared ?? 0) + 1, at: Math.min(p?.at ?? a.at, a.at), other: Math.min(p?.other ?? b.at, b.at) }) }
  }
  for (const [pair, p] of [...pairs].filter(([, p]) => p.shared >= MIN_SHARED).sort((x, y) => y[1].shared - x[1].shared)) {
    const [a, b] = pair.split('|') as [string, string]
    found.push({ kind: 'duplicate', key: sha(`duplicate ${pair}`), title: `Remove the duplicated code in ${a} and ${b}`, files: [a, b], evidence: `${a}:${p.at} and ${b}:${p.other} share ${p.shared} overlapping ${WINDOW}-line windows (at least ${p.shared + WINDOW - 1} lines of the same code).` })
  }
  // dead: a source file whose name no other tracked file mentions
  const texts = Object.entries(files)
  for (const f of src) {
    const base = path.basename(f).replace(/\.[^.]+$/, '')
    if (ENTRY.test(base) || base.length < 3 || BY_CONVENTION.test(f)) continue
    if (!texts.some(([g, t]) => g !== f && t.includes(base))) found.push({ kind: 'dead', key: sha(`dead ${f}`), title: `Remove ${f}, which nothing mentions`, files: [f], evidence: `No other tracked file contains "${base}": not imported, required, configured or documented. It may be an entry point loaded by name; check before removing.` })
  }
  // drift: a doc that cites a path that is not a tracked file
  const tracked = new Set(Object.keys(files))
  for (const doc of Object.keys(files).filter(f => /\.md$/.test(f)).sort()) {
    const missing = [...new Set([...(files[doc] ?? '').matchAll(/`([\w.@-]+(?:\/[\w.@-]+)+\.[A-Za-z0-9]{1,5})`/g)].map(m => m[1] as string))].filter(p => !GENERATED_CITES.test(p) && !tracked.has(p) && !tracked.has(path.posix.join(path.posix.dirname(doc), p)))
    if (missing.length) found.push({ kind: 'drift', key: sha(`drift ${doc} ${missing.join(',')}`), title: `Fix ${doc}, which cites paths that no longer exist`, files: [doc], evidence: `Cites ${missing.slice(0, 5).map(m => `\`${m}\``).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}, none of which is a tracked file.` })
  }
  return found
}

const slugOf = (f: Finding, n: number): string => `${f.kind}-${n}-${path.basename(f.files[0] ?? 'x').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`

function proposalText(f: Finding, slug: string): string {
  return `---\nkind: maintain\ntype: chore\nstatus: proposed\nfound: ${new Date().toISOString().slice(0, 10)}\nscope: [${f.files.join(', ')}]\n---\n# ${f.title}\n\n## Intent\n\n${f.evidence}\n\nFound by \`sdlc.ts maintain\`, not by a person: confirm it is real before acting on it.\n\n## Non-goals\n\nDo not change behaviour. Do not touch files outside \`scope\`.\n\n## How to start\n\n\`${skillRef('start')} ${slug.replace(/^[a-z]+-\d+-/, `${f.kind}-`)}\` with this file as the intent, then plan, approve and build as for any chore.\n`
}

export function cmdMaintain(args: Args): void {
  // -z: git quotes a path with non-ASCII characters otherwise, and the file would be silently unreadable.
  const list = (git(['ls-files', '-z']) ?? '').split('\0').filter(Boolean)
  const files: Record<string, string> = {}
  let bytes = 0
  for (const f of list) {
    if (SKIP.test(f)) continue
    const text = read(path.join(ROOT, f))
    if (text.length && text.length < MAX_BYTES && !text.includes('\0')) { files[f] = text; bytes += text.length }
  }
  const paths = parseRegistry(read(SENSORS_PATH)).registry.paths
  const cap = Number(typeof args.opt.cap === 'string' ? args.opt.cap : DEFAULT_CAP)
  const seenFile = path.join(SDLC, 'maintain', 'seen.json')
  let seen: Record<string, string> = {}
  if (fs.existsSync(seenFile)) { try { seen = JSON.parse(read(seenFile)) as Record<string, string> } catch { fail(`${path.relative(ROOT, seenFile)} is not valid JSON: delete it to start over (every finding is then proposed again), or fix it`) } }
  const fresh = scan(files, f => isTest(f, paths)).filter(f => !seen[f.key])
  const take = fresh.slice(0, Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_CAP)
  const dir = path.join(SDLC, 'maintain', 'proposals')
  fs.mkdirSync(dir, { recursive: true })
  // Numbered after what is already on disk, so a proposal is never overwritten, even when seen.json was lost.
  let n = Math.max(0, ...fs.readdirSync(dir).map(f => Number(/^[a-z]+-(\d+)-/.exec(f)?.[1] ?? 0)))
  const written = take.map(f => {
    const slug = slugOf(f, ++n)
    writeAtomic(path.join(dir, `${slug}.md`), proposalText(f, slug))
    seen[f.key] = new Date().toISOString().slice(0, 10)
    return { slug, ...f }
  })
  fs.mkdirSync(path.dirname(seenFile), { recursive: true })
  writeAtomic(seenFile, JSON.stringify(seen, null, 2) + '\n')
  if (args.opt.json) return out(JSON.stringify({ proposed: written, heldBack: fresh.length - take.length, scannedBytes: bytes }))
  out([written.length ? `maintain: proposed ${written.length} intent(s) under .rig/maintain/proposals/:` : 'maintain: nothing new to propose',
    ...written.map(w => `  ${w.slug}.md: ${w.title}`), ...(fresh.length > take.length ? [`${fresh.length - take.length} more held back by the cap of ${take.length}; run again later`] : [])].join('\n'))
}
