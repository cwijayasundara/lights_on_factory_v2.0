// Copies the harness into a project. Plain `vendor` copies the checker CI runs (.rig/bin). `vendor --standalone`
// also writes the skills, agents and hooks into .claude/, so the repo needs no plugin, cloud sessions included.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, PLUGIN_ROOT, IS_VENDORED, read, out, fail, sanctionWrites, sha, type Args } from './core.ts'
import { findBlock, withBlock } from './sync.ts'
import { HOOK_SCRIPTS, installHooks } from './githooks.ts'

// Every script the checker imports; testkit and specs stay behind. CI runs this copy, so it never needs the plugin.
export const VENDORED = ['core', 'model', 'sensors', 'diffs', 'runs', 'check', 'stamp', 'basetree', 'verify', 'hooks', 'pr', 'carry', 'prbody', 'sdlc', 'githooks', 'vendor', 'initbaseline', 'registry', 'stackpacks', 'modelstate', 'stackinit', 'contracts', 'sync', 'lifecycle', 'chart', 'superpowers', 'chartcheck', 'prdformat', 'plan', 'product', 'journey', 'wiki', 'wikicite', 'wikigen', 'wikistate', 'wikivalidate', 'learn', 'learnfile', 'learnmine', 'learnreplay', 'learntranscripts', 'report', 'arch', 'counts', 'queue', 'app', 'scope', 'slice', 'maintain', 'readiness', 'autonomy', 'upgrade', 'migrations', 'risk', 'reverts', 'reviewcases', 'protect', 'actrace']
const SDLC_HOOK = '.rig/bin/sdlc.ts'
type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number; async?: boolean }[] }

// Plugin references rewritten for a project copy: script paths, /rig:x skills, rig:x agents and the skill's name.
const AGENTS = ['architect', 'evaluator'] // agents/*.md; removed.spec.ts pins the set

// A vendored skill is registered under its folder name, so `/rig:start` becomes `/rig-start` (the 2026-10-16 pilot's init events);
// an agent takes a hyphen (`rig-architect`).
function forProject(text: string, kind: 'skill' | 'agent' = 'skill'): string {
  return text
    .replaceAll('"${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts"', SDLC_HOOK) // the human skills quote the plugin path; the project path needs no quotes
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('<plugin>/scripts/sdlc.ts', SDLC_HOOK)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}/templates/', '.rig/templates/')
    .replace(new RegExp(`(?<![/\\w])rig:(${AGENTS.join('|')})\\b`, 'g'), 'rig-$1')
    .replace(/\/rig:([a-z]+)\b/g, '/rig-$1')
    .replace(/^name: (?!rig[-:])(\S+)$/m, kind === 'skill' ? 'name: rig:$1' : 'name: rig-$1')
}

function writeFile(rel: string, text: string, written: string[]): void {
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
  fs.writeFileSync(path.join(ROOT, rel), text)
  written.push(rel)
}

// The plugin's settings hooks, pointed at the project copy and merged into .claude/settings.json. A re-run removes
// every previous sdlc entry, in any event (so hooks a newer version retired go too); the project's own hooks are kept.
function mergeHooks(written: string[]): void {
  const plugin = JSON.parse(read(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'))) as { hooks: Record<string, HookGroup[]> }
  const file = path.join(ROOT, '.claude', 'settings.json')
  const settings = (read(file) ? JSON.parse(read(file)) : {}) as Record<string, unknown> & { hooks?: Record<string, HookGroup[]>; extraKnownMarketplaces?: object; enabledPlugins?: Record<string, boolean> }
  const hooks = settings.hooks ?? {}
  const ours = (g: HookGroup): boolean => g.hooks.some(h => h.command.includes(SDLC_HOOK))
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = groups.filter(g => !ours(g))
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  for (const [event, groups] of Object.entries(plugin.hooks)) {
    const copied = groups.map(g => ({
      ...g,
      hooks: g.hooks.map(h => ({ ...h, command: h.command.replace('${CLAUDE_PLUGIN_ROOT}/scripts/sdlc.ts', `$CLAUDE_PROJECT_DIR/${SDLC_HOOK}`) })),
    }))
    hooks[event] = [...(hooks[event] ?? []), ...copied]
  }
  // The template's permissions too (deny and ask rules guard the evidence), merged under the project's own.
  mergeMissing(settings, { permissions: (JSON.parse(read(path.join(PLUGIN_ROOT, 'templates', 'settings.json'))) as { permissions: object }).permissions })
  // The dashboard mod is a local plugin: register its marketplace and enable it (an older 'rig-mod' entry is dropped).
  const { 'rig-mod@rig-local': _oldMod, ...enabled } = settings.enabledPlugins ?? {}
  const merged: Record<string, unknown> = {
    ...settings, hooks,
    extraKnownMarketplaces: { ...settings.extraKnownMarketplaces, 'rig-local': { source: { source: 'directory', path: '.' } } },
    enabledPlugins: { ...enabled, 'rig@rig-local': true },
  }
  writeFile('.claude/settings.json', JSON.stringify(merged, null, 2) + '\n', written)
}

export const pluginVersion = (): string => (JSON.parse(read(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'))) as { version?: string }).version ?? 'unknown'

// The journey dashboard (GOAL Scope 7) as a local plugin named 'rig': its state atoms are owned by plugin 'rig', so the copy must
// carry that name or the host refuses its writes.
function dashboardFiles(files: Map<string, string>): void {
  const version = pluginVersion()
  const json = (v: object): string => JSON.stringify(v, null, 2) + '\n'
  files.set('.rig/mod/hooks/dashboard.tsx', vendoredCommands(read(path.join(PLUGIN_ROOT, 'hooks', 'dashboard.tsx'))))
  files.set('.rig/mod/hooks/hooks.json', json({ modules: ['./dashboard.tsx'] }))
  files.set('.rig/mod/.claude-plugin/plugin.json', json({ name: 'rig', version, types: './types/index.d.ts' }))
  files.set('.rig/mod/types/index.d.ts', read(path.join(PLUGIN_ROOT, 'types', 'index.d.ts')))
}

// The mod's marketplace file is rewritten only when it is rig's own.
function writeMarketplace(written: string[]): void {
  const market = path.join(ROOT, '.claude-plugin', 'marketplace.json')
  const mine = ((): boolean => { try { return !read(market) || (JSON.parse(read(market)) as { name?: string }).name === 'rig-local' } catch { return false } })()
  if (mine) writeFile('.claude-plugin/marketplace.json', JSON.stringify({ name: 'rig-local', owner: { name: 'rig' }, plugins: [{ name: 'rig', source: './.rig/mod' }] }, null, 2) + '\n', written)
}

// Every file the harness owns outright, as repo-relative posix path to final text. The manifest hashes exactly these.
export const MANIFEST = '.rig/bin/MANIFEST.json'
export type Manifest = { version: string; files: Record<string, string> }
export function readManifest(): Manifest | null {
  try { return JSON.parse(read(path.join(ROOT, MANIFEST))) as Manifest } catch { return null }
}

// Where the harness may write or delete: a manifest key outside this namespace (or outside the repo) is never trusted.
const HARNESS_PREFIXES = ['.rig/bin/', '.rig/githooks/', '.rig/templates/', '.rig/mod/', '.claude/skills/rig-', '.claude/agents/rig-']
export function isHarnessPath(rel: string): boolean {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return false
  const abs = path.resolve(ROOT, rel)
  return abs.startsWith(ROOT + path.sep) && HARNESS_PREFIXES.some(p => rel.startsWith(p))
}

export function harnessFiles(standalone: boolean): Map<string, string> {
  const files = new Map<string, string>()
  for (const name of VENDORED) files.set(`.rig/bin/${name}.ts`, read(path.join(PLUGIN_ROOT, 'scripts', `${name}.ts`)))
  for (const [rel, text] of HOOK_SCRIPTS()) files.set(rel, text)
  files.set('.rig/bin/VERSION', `${pluginVersion()}\n`)
  if (!standalone) return files
  // The human-only skills (approve, waive, autonomy) come through here too: disable-model-invocation keeps them the person's, and
  // CI refuses approval rows a PR adds unless an independent reviewer approves.
  for (const name of fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'))) {
    if (name === 'upgrade') continue // upgrade runs only from the plugin (upgradeGates refuses a vendored copy)
    const src = path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md')
    if (fs.existsSync(src)) files.set(`.claude/skills/rig-${name}/SKILL.md`, forProject(read(src)))
  }
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'agents')).filter(f => f.endsWith('.md'))) {
    files.set(`.claude/agents/rig-${file}`, forProject(read(path.join(PLUGIN_ROOT, 'agents', file)), 'agent'))
  }
  const templates = path.join(PLUGIN_ROOT, 'templates')
  for (const file of (fs.readdirSync(templates, { recursive: true }) as string[]).filter(f => fs.statSync(path.join(templates, f)).isFile()).sort()) {
    const text = read(path.join(templates, file))
    files.set(`.rig/templates/${file}`, file === README_TEMPLATE ? vendoredCommands(text) : text)
  }
  dashboardFiles(files)
  return files
}

// The files a project owns a share of, merged in place and never hashed: settings, CLAUDE.md, the README, the PRD docs, the marketplace.
export function mergeProjectFiles(written: string[]): void {
  mergeHooks(written)
  routeClaudeMd(written)
  routeReadme(written)
  routePrdDocs(written)
  writeMarketplace(written)
}

const README_TEMPLATE = 'readme-rig.md'
const README_BLOCK = /<!-- rig:begin[\s\S]*?<!-- rig:end -->/
const vendoredCommands = (text: string): string => text.replace(/\/rig:([a-z]+)\b/g, '/rig-$1')

// CLAUDE.md's routing line and guides block are written while the plugin's /rig:x names are live; a standalone copy answers to /rig-x
// (the folder name), so what a model reads agrees with the session-start hook and `status`. Only the routing line and the guides block
// are touched; the block is re-hashed so the vendored `sync` finds it current, unless it was edited by hand (then `sync` reports it).
function routeClaudeMd(written: string[]): void {
  const file = 'CLAUDE.md'
  const text = read(path.join(ROOT, file))
  let routed = text.replace('start with /rig:start;', 'start with /rig-start;')
  const block = findBlock(routed)
  if (block && sha(block.lines.join('\n')) === block.hash) routed = withBlock(routed, block.lines.map(vendoredCommands))
  if (routed !== text) writeFile(file, routed, written)
}

// The README's rig block (from templates/readme-rig.md) tells a person which commands to type; in a standalone copy those are /rig-x
// (2026-10-25 shop_app run: the block said /rig:start, which does not exist there). Text outside the markers is never touched.
function routeReadme(written: string[]): void {
  const file = 'README.md'
  const text = read(path.join(ROOT, file))
  const routed = text.replace(README_BLOCK, vendoredCommands)
  if (routed !== text) writeFile(file, routed, written)
}

// init --stack writes these two before init --full vendors, so they still name /rig:chart; a person's PRDs are never touched.
function routePrdDocs(written: string[]): void {
  for (const file of ['docs/prd/README.md', 'docs/prd/prd-template.md']) {
    const text = read(path.join(ROOT, file))
    const routed = vendoredCommands(text)
    if (routed !== text) writeFile(file, routed, written)
  }
}

export const older = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map(v => v.split('.').map(n => Number.parseInt(n, 10) || 0))
  for (let i = 0; i < 3; i++) if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0)
  return false
}

// The refusals vendor and upgrade share: a newer install than this plugin, and settings.json that is not plain JSON.
export function versionGuards(verb: string, args: Args): void {
  const have = read(path.join(SDLC, 'bin', 'VERSION')).trim()
  const next = pluginVersion()
  if (have && older(next, have) && !args.opt.force) fail(`.rig/bin is ${have}, newer than this plugin (${next}); upgrade the plugin first, or pass --force to downgrade`)
  try { if (read(path.join(ROOT, '.claude', 'settings.json'))) JSON.parse(read(path.join(ROOT, '.claude', 'settings.json'))) } catch { fail(`.claude/settings.json is not plain JSON (comments or trailing commas?); fix it first so ${verb} does not leave a half-written tree`) }
}

export function cmdVendor(args: Args): void {
  if (IS_VENDORED) fail('run vendor from the sdlc plugin, not from a project copy')
  if (older(process.versions.node, '22.18.0')) fail(`rig needs Node >= 22.18 (this is ${process.versions.node}); on an older Node its hooks fail silently and every gate is off`)
  versionGuards('vendoring', args)
  const next = pluginVersion()
  const written: string[] = []
  const standalone = Boolean(args.opt.standalone)
  const files = harnessFiles(standalone)
  if (standalone) fs.rmSync(path.join(ROOT, '.rig', 'mod'), { recursive: true, force: true })
  for (const [rel, text] of files) {
    writeFile(rel, text, written)
    if (rel.startsWith('.rig/githooks/')) fs.chmodSync(path.join(ROOT, rel), 0o755)
  }
  if (standalone) mergeProjectFiles(written)
  // A plain vendor owns only the .rig/bin files: it keeps the standalone entries an earlier `vendor --standalone` recorded.
  const kept = standalone ? {} : readManifest()?.files ?? {}
  const hashes = Object.fromEntries([...Object.entries(kept), ...[...files].map(([rel, text]): [string, string] => [rel, sha(text)])].sort(([a], [b]) => a.localeCompare(b, 'en')))
  writeFile(MANIFEST, JSON.stringify({ version: next, files: hashes }, null, 2) + '\n', written)
  sanctionWrites(written)
  out(standalone
    ? `vendored sdlc ${next} standalone: .rig/bin, .claude/skills/rig-*, .claude/agents/rig-*, hooks in .claude/settings.json. Commit .rig/ and .claude/; re-run from the plugin to upgrade.`
    : `vendored sdlc ${next} into ${path.relative(ROOT, path.join(SDLC, 'bin'))} (${VENDORED.length} files). Commit it; CI runs the base branch's copy.`)
}

// Settings the template wants, merged under what the project already has: arrays are unioned and a key the project
// already sets keeps its value, so onboarding never overrides a team's own choice.
function mergeMissing(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [k, v] of Object.entries(from)) {
    const have = into[k]
    if (Array.isArray(v)) into[k] = [...new Set([...(Array.isArray(have) ? have : []), ...v])]
    else if (v && typeof v === 'object') into[k] = mergeMissing(have && typeof have === 'object' && !Array.isArray(have) ? have as Record<string, unknown> : {}, v as Record<string, unknown>)
    else if (have === undefined) into[k] = v
  }
  return into
}

// `init --full [--workflows]`: the deterministic half of onboarding, so the model need not hand-copy files. Vendors the
// standalone harness, wires the git hooks and merges templates/settings.json. The CI workflows and REVIEW.md need a
// remote, so they are written only with --workflows, and never over a file that is already there.
export function installStandalone(workflows: boolean): string {
  cmdVendor({ pos: [], opt: { standalone: true } })
  const hooks = installHooks()
  const lines = [hooks.ok ? hooks.message : `git hooks not installed: ${hooks.message}`]
  const file = path.join(ROOT, '.claude', 'settings.json')
  const { $comment: _comment, ...template } = JSON.parse(read(path.join(PLUGIN_ROOT, 'templates', 'settings.json'))) as Record<string, unknown>
  const merged = mergeMissing(JSON.parse(read(file) || '{}') as Record<string, unknown>, template)
  // An earlier template wrote this false, and mergeMissing keeps the project's value; rig's skills invoke superpowers, so it must be on.
  const plugins = (merged.enabledPlugins ?? {}) as Record<string, boolean>
  merged.enabledPlugins = { ...plugins, 'superpowers@claude-plugins-official': true }
  const written: string[] = []
  writeFile('.claude/settings.json', JSON.stringify(merged, null, 2) + '\n', written)
  lines.push('merged templates/settings.json into .claude/settings.json (existing values kept)')
  if (workflows) {
    for (const [from, to] of [['rig-check.yml', '.github/workflows/rig-check.yml'], ['rig-maintain.yml', '.github/workflows/rig-maintain.yml'], ['REVIEW.md', 'REVIEW.md']] as const) {
      if (fs.existsSync(path.join(ROOT, to))) lines.push(`${to} already exists; left as it is`)
      else { writeFile(to, read(path.join(PLUGIN_ROOT, 'templates', from)), written); lines.push(`wrote ${to}`) }
    }
  }
  sanctionWrites(written)
  return lines.join('\n')
}
