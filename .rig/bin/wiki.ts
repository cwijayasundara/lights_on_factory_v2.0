// `sdlc.ts wiki <init|build|status|verify|refresh|sync>` (wiki design 2026-10-17). Everything checkable is deterministic; only page writing
// and claim review call a model, through a Runner. Staleness is a warning: no subcommand fails because a page is stale.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, out, fail, gitIn, writeAtomic, usdOpt, skillRef, type Args } from './core.ts'
import { claudeRunner, planConfig, buildPage, reviewPage, estimateUsd, type Runner } from './wikigen.ts'
import { parseWikiConfig, slugOf, snapshot, wikiStatus, type WikiConfig, type WikiPage, type WikiState } from './wikistate.ts'
import { validatePage, pageCitations, type PageEnv } from './wikivalidate.ts'

type WikiResult = { code: number; text: string }

const CONFIG = '.rig/wiki.json'
const DIR = '.rig/wiki'
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|cs|php|swift|c|cc|cpp|h|hpp|scala|exs?|lua|sh)$/
const SKIPPED = /^(?:\.rig|\.claude|\.github|node_modules)\//
const MAX_SOURCE_CHARS = 120_000

const ok = (text: string): WikiResult => ({ code: 0, text })
const bad = (text: string, code = 1): WikiResult => ({ code, text })

function reader(root: string): (p: string) => string | null {
  return p => {
    const abs = path.resolve(root, p)
    if (path.isAbsolute(p) || !abs.startsWith(root + path.sep)) return null
    try { return fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') } catch { return null }
  }
}

const sourceFiles = (root: string): string[] =>
  (gitIn(root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(f => SOURCE_EXT.test(f) && !SKIPPED.test(f))

function pageSources(root: string, page: WikiPage, files: string[]): Record<string, string> {
  const read = reader(root)
  const mine = page.paths ? files.filter(f => page.paths!.some(p => (p.endsWith('/') ? f.startsWith(p) : f === p))) : files
  const out: Record<string, string> = {}
  let total = 0
  for (const f of [...mine].sort()) {
    const text = read(f) ?? ''
    if (total + text.length > MAX_SOURCE_CHARS) continue
    out[f] = text
    total += text.length
  }
  return out
}

function whyExists(root: string): PageEnv['whyExists'] {
  return c => {
    if (c.type === 'adr') {
      const dir = path.join(root, '.rig/product/adr')
      return fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.startsWith(c.ref.padStart(4, '0')))
    }
    if (c.type === 'commit') return gitIn(root, ['cat-file', '-e', `${c.ref}^{commit}`]) !== null
    return Boolean(gitIn(root, ['log', '--all', '-1', '--format=%H', `--grep=#${c.ref}\\b`]))
  }
}

const env = (root: string): PageEnv => ({ read: reader(root), whyExists: whyExists(root) })

function loadConfig(root: string): WikiConfig | string {
  const text = reader(root)(CONFIG)
  if (text === null) return `no ${CONFIG}: run \`wiki init\` first, edit it, then \`wiki build\``
  return parseWikiConfig(text)
}

// Only the pages the config names; a leftover .md the config no longer lists is an orphan (reported by status), not a page.
function loadPages(root: string, config: WikiConfig | string): { pages: Record<string, string>; orphans: string[] } {
  const dir = path.join(root, DIR)
  if (!fs.existsSync(dir)) return { pages: {}, orphans: [] }
  const known = typeof config === 'string' ? null : new Set(config.pages.map(p => slugOf(p.title)))
  const pages: Record<string, string> = {}, orphans: string[] = []
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.md') && x !== 'index.md')) {
    if (known && !known.has(f.slice(0, -3))) orphans.push(f)
    else pages[f.slice(0, -3)] = reader(root)(`${DIR}/${f}`) ?? ''
  }
  return { pages, orphans }
}

const loadState = (root: string): WikiState => {
  try {
    const s = JSON.parse(reader(root)(`${DIR}/state.json`) ?? '') as Partial<WikiState> | null
    return s && typeof s.pages === 'object' && s.pages !== null && !Array.isArray(s.pages) ? { pages: s.pages } : { pages: {} }
  } catch { return { pages: {} } }
}

function indexText(config: WikiConfig, state: WikiState): string {
  const line = (p: WikiPage, depth: number): string[] => [
    state.pages[slugOf(p.title)] ? `${'  '.repeat(depth)}- [${p.title}](${slugOf(p.title)}.md): ${p.purpose} (built ${state.pages[slugOf(p.title)]!.builtAt})` : `${'  '.repeat(depth)}- ${p.title} (not built yet): ${p.purpose}`,
    ...config.pages.filter(c => c.parent === p.title).flatMap(c => line(c, depth + 1)),
  ]
  return `# Wiki\n\n${config.pages.filter(p => !p.parent).flatMap(p => line(p, 0)).join('\n')}\n`
}

const money = (n: number): string => `$${n.toFixed(4)}`

function maxUsd(args: Args): number | null | string {
  const n = usdOpt(args, 0)
  return n === null || !Number.isNaN(n) ? n : '--max-usd needs a number of dollars'
}

// Builds the given pages. `hintFor` adds what changed to a refresh; a page that cannot be built keeps its old file.
function buildPages(root: string, config: WikiConfig, pages: WikiPage[], args: Args, run: Runner, hintFor: (p: WikiPage) => string | undefined): WikiResult {
  const budget = maxUsd(args)
  if (typeof budget === 'string') return bad(budget, 2)
  const files = sourceFiles(root)
  const sources = new Map(pages.map(p => [p.title, pageSources(root, p, files)]))
  const chars = [...sources.values()].reduce((n, s) => n + Object.values(s).reduce((m, t) => m + t.length, 0), 0)
  const estimate = estimateUsd(pages.length, chars)
  const lines = [`estimate: ${money(estimate)} for ${pages.length} page(s)`]
  if (budget !== null && estimate > budget) return bad([...lines, `over --max-usd ${budget}: nothing was run`].join('\n'))
  const state = loadState(root)
  const commit = gitIn(root, ['rev-parse', '--short', 'HEAD']) ?? 'none'
  const e = env(root)
  let usd = 0
  let failed = 0
  for (const page of pages) {
    const hint = hintFor(page)
    let r: ReturnType<typeof buildPage>
    try {
      r = buildPage({ page, sources: sources.get(page.title)!, env: e, run, ...(hint ? { hint } : {}) })
    } catch (err) {
      failed++
      lines.push(`${page.title}: failed (${err instanceof Error ? err.message : String(err)}); the old page is kept`)
      continue
    }
    usd += r.usd
    if (r.text === null) {
      failed++
      lines.push(`${page.title}: not written (${r.error ?? r.findings.map(f => `${f.rule}@${f.line}`).join(', ')}); the old page is kept`)
      continue
    }
    const slug = slugOf(page.title)
    writeAtomic(path.join(root, DIR, `${slug}.md`), r.text)
    state.pages[slug] = snapshot(r.text, e.read, commit)
    lines.push(`${page.title}: written${r.dropped ? `, ${r.dropped} unsupported claim(s) dropped` : ''}${r.findings.length ? `; ${r.findings[0]!.message}` : ''}`)
  }
  writeAtomic(path.join(root, DIR, 'state.json'), JSON.stringify(state, null, 2) + '\n')
  writeAtomic(path.join(root, DIR, 'index.md'), indexText(config, state))
  lines.push(`cost: ${money(usd)}`)
  return { code: failed ? 1 : 0, text: lines.join('\n') }
}

function cmdInit(root: string, run: Runner): WikiResult {
  if (fs.existsSync(path.join(root, CONFIG))) return bad(`${CONFIG} already exists; edit it, then run \`wiki build\``)
  const r = planConfig(sourceFiles(root), run)
  if (typeof r.config === 'string') return bad(`the planner's wiki.json is not usable: ${r.config}`)
  writeAtomic(path.join(root, CONFIG), JSON.stringify(r.config, null, 2) + '\n')
  return ok(`wrote ${CONFIG} with ${r.config.pages.length} page(s) (cost ${money(r.usd)}). Edit it, then run: wiki build`)
}

function cmdBuild(root: string, args: Args, run: Runner): WikiResult {
  const config = loadConfig(root)
  if (typeof config === 'string') return bad(config)
  const only = typeof args.opt.page === 'string' ? args.opt.page.toLowerCase() : null
  const pages = only ? config.pages.filter(p => p.title.toLowerCase() === only || slugOf(p.title) === only) : config.pages
  if (!pages.length) return bad(`no page "${args.opt.page}" in ${CONFIG}`)
  return buildPages(root, config, pages, args, run, () => undefined)
}

function staleSlugs(root: string, config: WikiConfig | string = loadConfig(root)): { stale: ReturnType<typeof wikiStatus>; pages: Record<string, string>; orphans: string[] } {
  const { pages, orphans } = loadPages(root, config)
  return { stale: wikiStatus(loadState(root), pages, reader(root)), pages, orphans }
}

function cmdStatus(root: string): WikiResult {
  const { stale, pages, orphans } = staleSlugs(root)
  const warn = orphans.map(f => `warning: ${DIR}/${f} is not in ${CONFIG}; delete it or add the page`)
  if (!Object.keys(pages).length) return ok([...warn, 'wiki: no pages yet (wiki init, edit wiki.json, wiki build)'].join('\n'))
  const names = new Set(stale.map(s => s.page))
  return ok([...warn, ...stale.map(s => `${s.page}: ${s.cite} (${s.why})`), names.size ? `wiki: ${names.size} stale page(s); \`wiki refresh\` rebuilds them` : 'wiki: fresh'].join('\n'))
}

function cmdRefresh(root: string, args: Args, run: Runner): WikiResult {
  const config = loadConfig(root)
  if (typeof config === 'string') return bad(config)
  const { stale } = staleSlugs(root, config)
  const names = new Set(stale.map(s => s.page))
  const pages = config.pages.filter(p => names.has(slugOf(p.title)))
  if (!pages.length) return ok('wiki: fresh; nothing to refresh')
  const state = loadState(root)
  return buildPages(root, config, pages, args, run, p => {
    const cited = [...new Set(stale.filter(s => s.page === slugOf(p.title)).map(s => s.cite.split('#')[0]!))]
    // builtAt comes from a committed file: only a plain hex revision is ever handed to git.
    const at = state.pages[slugOf(p.title)]?.builtAt
    const diff = gitIn(root, ['diff', '--stat', at && /^[0-9a-f]{4,40}$/.test(at) ? at : 'HEAD', '--', ...cited])
    return `Changed since the last build: ${cited.join(', ')}${diff ? `\n${diff}` : ''}`
  })
}

// Run at the end of /rig:pr, before the commit: the first run on a repo with no wiki.json plans and builds it (no edit step, so a
// greenfield repo gets a wiki once code exists); later runs refresh the stale pages. Warn-only: a failure or an over-budget estimate
// is printed as a warning and never stops the change from shipping.
function cmdSync(root: string, args: Args, run: Runner): WikiResult {
  if (!sourceFiles(root).length) return ok('wiki: no source files yet; nothing to build')
  const soft = (r: WikiResult): WikiResult => ({ code: 0, text: r.code === 0 ? r.text : `warning: the wiki was not fully synced\n${r.text}` })
  if (fs.existsSync(path.join(root, CONFIG))) return soft(cmdRefresh(root, args, run))
  const planned = cmdInit(root, run)
  if (planned.code !== 0) return soft(planned)
  // Marks the config as built from the repo's own sprints, so the journey still reads the repo as greenfield (journey.ts repoKind).
  const file = path.join(root, CONFIG)
  writeAtomic(file, JSON.stringify({ origin: 'sync', ...JSON.parse(fs.readFileSync(file, 'utf8')) }, null, 2) + '\n')
  const built = cmdBuild(root, args, run)
  return soft({ code: built.code, text: `${planned.text}\n${built.text}` })
}

function cmdVerify(root: string, args: Args, run: Runner): WikiResult {
  const { pages } = loadPages(root, loadConfig(root))
  if (!Object.keys(pages).length) return ok('wiki: no pages yet')
  const e = env(root)
  const lines: string[] = []
  for (const [slug, text] of Object.entries(pages)) {
    for (const f of validatePage(text, e)) lines.push(`${slug}:${f.line} ${f.rule} ${f.message}`)
    if (args.opt['no-review']) continue
    const sources: Record<string, string> = {}
    for (const { cite } of pageCitations(text)) if (cite.kind === 'code') sources[cite.path] = e.read(cite.path) ?? ''
    const r = reviewPage(text, sources, run)
    if (r.error) lines.push(`${slug}: review failed: ${r.error}`)
    for (const v of r.verdicts) if (v.verdict !== 'supported') lines.push(`${slug}:${v.line} ${v.verdict}`)
  }
  return lines.length ? bad(lines.join('\n')) : ok(`wiki: ${Object.keys(pages).length} page(s) pass`)
}

// `wiki init` indexes an existing codebase, which has history. A repo with no commit is a fresh scaffold: refuse before the paid planner
// runs (2026-10-25 shop_app: greenfield /rig:init ran it on a two-file skeleton). A greenfield repo gets its wiki from `wiki sync`.
const hasCommit = (root: string): boolean => gitIn(root, ['rev-parse', '--verify', '-q', 'HEAD']) !== null
const NO_COMMIT = `wiki init: this repo has no commit yet, so there is no codebase to index (nothing was run, no cost).
Greenfield: skip it; ${skillRef('pr')} builds the wiki after the first change. Brownfield: commit the code, then run wiki init again.`

export function wikiCommand(root: string, args: Args, run: Runner): WikiResult {
  switch (args.pos[0]) {
    case 'init': return hasCommit(root) ? cmdInit(root, run) : bad(NO_COMMIT)
    case 'build': return cmdBuild(root, args, run)
    case 'status': return cmdStatus(root)
    case 'refresh': return cmdRefresh(root, args, run)
    case 'sync': return cmdSync(root, args, run)
    case 'verify': return cmdVerify(root, args, run)
    default: return bad('usage: wiki <init|build [--page <title>] [--max-usd N]|status|verify [--no-review]|refresh [--max-usd N]|sync [--max-usd N]>', 2)
  }
}

export function cmdWiki(args: Args, run: Runner = claudeRunner()): void {
  const r = wikiCommand(ROOT, args, run)
  if (r.code === 0) out(r.text)
  else fail(r.text, r.code)
}
