// `sdlc arch` (harness readiness 1.1, design 2026-10-21): the dependency direction a repo declares in architecture.md, approved by a
// person, then enforced by the layering sensor at edit time and by the stack's own analyser (import-linter, dependency-cruiser) at commit.
// Enforcement reads only the approved record, never architecture.md, so editing the block can start a proposal but never loosen a rule.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, SENSORS_PATH, PLUGIN_ROOT, ownerOrFail, out, fail, read, readJson, exists, sha, writeAtomic, sanctionWrites, type Args } from './core.ts'
import { parseRegistry } from './registry.ts'
import { escapeRe, type Layer } from './model.ts'
import { ARCH_REL } from './product.ts'
import { SHELL } from './runs.ts'

const APPROVED = '.rig/layers.approved.json'
const GEN = '.rig/gen'
const MIN_TOKEN = 3
// Globs and names reach shell commands and generated config; only these characters are allowed in them.
const SAFE_GLOB = /^[A-Za-z0-9_./*-]+$/, SAFE_NAME = /^[A-Za-z0-9_-]+$/, SAFE_REF = /^[A-Za-z0-9_.@/-]+$/
const segsOf = (g: string): string[] => g.split('/').filter((x, i, a) => !(x === '**' && i === a.length - 1))
const segEq = (a: string, b: string): boolean => a === b || a === '*' || b === '*' || (a.includes('*') && new RegExp(`^${a.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(b))
// Two globs overlap when the shorter one's directories match the start of the longer one's, wildcards matching any one directory.
const overlaps = (a: string, b: string): boolean => { const x = segsOf(a), y = segsOf(b), n = Math.min(x.length, y.length); return n > 0 && x.slice(0, n).every((v, i) => segEq(v, y[i] as string)) }

export type Def = { layers: { name: string; glob: string; token: string }[]; allow: Record<string, string[]>; forbid: Record<string, string[]>; example: Record<string, string> }
type Analyser = 'import-linter' | 'dependency-cruiser'
// templates/layers/<stack>.json: the tool's own commands live there as data, never in this file (core neutrality).
type Tool = { analyser: Analyser; root: string; config: string; baseline: string; install: string }
type Record_ = { by: string; at: string; blockHash: string; analyser: Analyser | null; def: Def; layers: Layer[] }

const list = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)
// The last path segment without a wildcard: src/features/*/domain/** is "domain".
const tokenOf = (glob: string): string => glob.split('/').filter(seg => seg && !seg.includes('*')).pop() ?? ''

export function parseLayers(md: string): { def: Def | null; block: string; errors: string[] } {
  const m = /```rig-layers\n([\s\S]*?)```/.exec(md)
  if (!m) return { def: null, block: '', errors: [] }
  const block = (m[1] ?? '').trim()
  const def: Def = { layers: [], allow: {}, forbid: {}, example: {} }
  const errors: string[] = []
  for (const raw of block.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const layer = /^layer\s+(\S+)\s+(\S+)$/.exec(line), rule = /^(allow|forbid)\s+(\S+)\s*->\s*(.+)$/.exec(line), ex = /^example\s+(\S+)\s+(\S+)$/.exec(line)
    if (layer) def.layers.push({ name: layer[1] as string, glob: layer[2] as string, token: tokenOf(layer[2] as string) })
    else if (rule) (rule[1] === 'allow' ? def.allow : def.forbid)[rule[2] as string] = list(rule[3] as string)
    else if (ex) def.example[ex[1] as string] = ex[2] as string
    else errors.push(`cannot read: ${line}`)
  }
  return { def, block, errors }
}

export function validateLayers(d: Def): string[] {
  const errors: string[] = []
  const names = d.layers.map(l => l.name)
  for (const l of d.layers) {
    if (!l.token) errors.push(`layer ${l.name}: ${l.glob} has no literal directory in it`)
    else if (l.token.length < MIN_TOKEN) errors.push(`layer ${l.name}: token "${l.token}" is under ${MIN_TOKEN} characters and would match unrelated imports`)
    if (!SAFE_NAME.test(l.name)) errors.push(`layer name "${l.name}" may use only letters, digits, - and _`)
    if (!SAFE_GLOB.test(l.glob) || l.glob.split('/').includes('..')) errors.push(`layer ${l.name}: glob "${l.glob}" may use only letters, digits, . _ - / and *, and no ..`)
    if (names.filter(n => n === l.name).length > 1) errors.push(`layer ${l.name} is declared twice`)
    if (d.layers.some(o => o !== l && o.token === l.token)) errors.push(`layer ${l.name}: token "${l.token}" is shared with another layer`)
    for (const o of d.layers.slice(d.layers.indexOf(l) + 1)) if (overlaps(l.glob, o.glob)) errors.push(`layer ${l.name} overlaps layer ${o.name}: nested layers and shared directories are not supported`)
  }
  for (const [kind, table] of [['allow', d.allow], ['forbid', d.forbid], ['example', d.example]] as const) {
    for (const k of Object.keys(table)) if (!names.includes(k)) errors.push(`${kind} names an unknown layer: ${k}`)
  }
  for (const x of [...Object.values(d.forbid).flat(), ...Object.values(d.example)]) if (!SAFE_REF.test(x)) errors.push(`"${x}" may use only letters, digits, . _ - / and @`)
  for (const [a, to] of Object.entries(d.allow)) for (const b of to) if (!names.includes(b)) errors.push(`allow ${a} -> ${b}: unknown layer`)
  for (const l of d.layers) for (const x of d.forbid[l.name] ?? []) if (d.layers.some(o => o.token === x)) errors.push(`forbid ${l.name} -> ${x} names a layer: use allow`)
  // an allow cycle: A may import B and B may import A
  const reaches = (a: string, seen = new Set<string>()): Set<string> => { for (const b of d.allow[a] ?? []) if (!seen.has(b)) { seen.add(b); reaches(b, seen) } return seen }
  for (const n of names) if (reaches(n).has(n)) errors.push(`allow rules form a cycle through ${n}`)
  return errors
}

// Not an error: a greenfield repo declares its layers before it writes them. A typo shows up here instead.
export function missingDirs(d: Def, dirExists: (p: string) => boolean): string[] {
  return d.layers.flatMap(l => { const parts = l.glob.split('/'), at = parts.findIndex(x => x.includes('*')), prefix = parts.slice(0, at < 0 ? parts.length : at).join('/'); return prefix && !dirExists(prefix) ? [`layer ${l.name}: ${prefix} does not exist yet`] : [] })
}

// What the layering sensor enforces: every other layer not allowed, plus the forbidden external names.
export function deriveLayering(d: Def): Layer[] {
  return d.layers.flatMap((l): Layer[] => {
    const allowed = d.allow[l.name] ?? []
    const banned = [...d.layers.filter(o => o.name !== l.name && !allowed.includes(o.name)).map(o => o.token), ...(d.forbid[l.name] ?? [])]
    const ex = d.example[l.name]
    return banned.length ? [{ from: l.glob, mustNotImport: banned, why: `${l.name} may import only ${allowed.join(', ') || 'nothing from other layers'} (architecture.md ## Layers)`, ...(ex ? { example: ex } : {}) }] : []
  })
}

const pairs = (d: Def): { a: string; b: string; id: string }[] => d.layers.flatMap(a => d.layers.filter(b => b.name !== a.name && !(d.allow[a.name] ?? []).includes(b.name)).map(b => ({ a: a.name, b: b.name, id: `rig-${a.name}-${b.name}` })))
// A layer glob as a dependency-cruiser path regex: ** is any depth, * one directory; a glob not ending in ** still ends at a directory boundary.
const rx = (glob: string): string => {
  const r = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/|\/\*\*$|\*\*|\*/g, m => ({ '**/': '(?:[^/]+/)*', '/**': '/', '**': '.*', '*': '[^/]*' })[m] as string)
  return `^${r}${r.endsWith('/') ? '' : '(/|$)'}`
}

export function renderDepcruise(d: Def): string {
  const glob = (n: string): string => d.layers.find(l => l.name === n)?.glob ?? ''
  const fix = (a: string, b: string): string => `Fix: depend on an interface owned by ${a} and inject ${b} at the boundary.${d.example[a] ? ` Example: ${d.example[a]}.` : ''}`
  const rules = [
    ...pairs(d).map(p => ({ name: p.id, severity: 'error', comment: `${p.a} must not import ${p.b}. ${fix(p.a, p.b)}`, from: { path: rx(glob(p.a)) }, to: { path: rx(glob(p.b)) } })),
    ...d.layers.flatMap(l => (d.forbid[l.name] ?? []).map(x => ({ name: `rig-${l.name}-no-${x}`, severity: 'error', comment: `${l.name} must not import ${x}. ${fix(l.name, x)}`, from: { path: rx(glob(l.name)) }, to: { path: `(^|/)node_modules/${escapeRe(x)}(/|$)` } }))),
  ]
  return `// Generated by sdlc arch approve from architecture.md ## Layers. Do not edit: a person re-approves instead.\nmodule.exports = ${JSON.stringify({ forbidden: rules, options: { doNotFollow: { path: 'node_modules' } } }, null, 2)}\n`
}

// import-linter names modules, not paths: src/shop/domain/** is shop.domain with src on the path. Null when a glob cannot be a module.
export function moduleOf(glob: string): string | null {
  const dir = glob.replace(/\/?\*\*$/, '')
  return dir.includes('*') ? null : dir.replace(/^src\//, '').replace(/\//g, '.')
}
export function renderImportLinter(d: Def, known: Record<string, string[]> = {}): string | null {
  const mod = (n: string): string | null => moduleOf(d.layers.find(l => l.name === n)?.glob ?? '')
  if (d.layers.some(l => !mod(l.name))) return null
  const root = (mod(d.layers[0]?.name ?? '') ?? '').split('.')[0]
  if (d.layers.some(l => (mod(l.name) ?? '').split('.')[0] !== root)) return null
  const contract = (id: string, name: string, src: string, forbidden: string): string => `[importlinter:contract:${id}]\nname = ${name}\ntype = forbidden\nsource_modules = ${src}\nforbidden_modules = ${forbidden}\n${known[id]?.length ? `ignore_imports =\n${known[id].map(k => `    ${k}`).join('\n')}\n` : ''}`
  return [`# Generated by sdlc arch approve from architecture.md ## Layers. Do not edit: a person re-approves instead.\n[importlinter]\nroot_package = ${root}\n`,
    ...pairs(d).map(p => contract(p.id, `${p.a} must not import ${p.b}`, mod(p.a) as string, mod(p.b) as string)),
    ...d.layers.flatMap(l => (d.forbid[l.name] ?? []).map(x => contract(`rig-${l.name}-no-${x}`, `${l.name} must not import ${x}`, mod(l.name) as string, x)))].join('\n')
}

export const approvedLayers = (text: string): Layer[] => { try { const r = JSON.parse(text) as Partial<Record_>; return Array.isArray(r.layers) ? r.layers : [] } catch { return [] } }
export const approvedDef = (): Def | null => readRecord()?.def ?? null
const readRecord = (): Record_ | null => readJson<Record_ | null>(path.join(ROOT, APPROVED), null)

type LayerState = 'none' | 'proposed' | 'approved' | 'drifted'
export function layerState(): { state: LayerState; by?: string; at?: string } {
  const block = parseLayers(read(path.join(ROOT, ARCH_REL))).block
  const rec = readRecord()
  if (!rec) return { state: block ? 'proposed' : 'none' }
  return { state: sha(block) === rec.blockHash ? 'approved' : 'drifted', by: rec.by, at: rec.at }
}
export const layerStateText = (s: ReturnType<typeof layerState>): string =>
  ({ none: 'not configured', proposed: 'proposed, awaiting approval (nothing enforced)', approved: `approved by ${s.by} ${s.at?.slice(0, 10)}`, drifted: 'block differs from the approval (the approved rules still apply; re-approve to change them)' })[s.state]

// ---------- the analysers ----------
const KNOWN = `${GEN}/known-violations.json`
const roots = (d: Def): string[] => [...new Set(d.layers.map(l => l.glob.split('/')[0] ?? '.'))]
const toolOf = (stack: string): Tool | null => readJson<Tool | null>(path.join(PLUGIN_ROOT, 'templates', 'layers', `${stack}.json`), null)

function baselineRun(tool: Tool, d: Def): { missing: boolean; failed: string | null; text: string } {
  const r = spawnSync(tool.baseline.replaceAll('{roots}', roots(d).join(' ')), { cwd: ROOT, encoding: 'utf8', shell: SHELL || true, maxBuffer: 64 * 1024 * 1024 })
  const err = r.stderr ?? ''
  const missing = r.status === 127 || /could not determine executable|command not found/i.test(err)
  // import-linter exits 1 for broken contracts, which is the baseline; anything else is the tool failing.
  return { missing, failed: !missing && (r.status ?? 1) > 1 ? `exit ${r.status}: ${(err || r.stdout || '').trim().split('\n')[0]}` : null, text: `${r.stdout ?? ''}${tool.analyser === 'import-linter' ? err : ''}` }
}

// import-linter prints "<contract name>\n----\n...\n-   a.b -> c.d (l.3)" per broken contract.
export function pythonViolations(text: string, d: Def): Record<string, string[]> {
  const byName = Object.fromEntries([...pairs(d).map(p => [`${p.a} must not import ${p.b}`, p.id]), ...d.layers.flatMap(l => (d.forbid[l.name] ?? []).map(x => [`${l.name} must not import ${x}`, `rig-${l.name}-no-${x}`]))])
  const found: Record<string, string[]> = {}
  let id = ''
  for (const line of text.split('\n')) {
    if (byName[line.trim()]) id = byName[line.trim()] as string
    const m = /^-\s+(\S+ -> \S+) \(l\.\d+(?:, l\.\d+)*\)/.exec(line)
    if (m && id) (found[id] ??= []).push(m[1] as string)
  }
  return found
}
const keysOf = (k: unknown): string[] => (Array.isArray(k) ? k.map(v => `${v?.rule?.name}|${v?.from}|${v?.to}`) : Object.entries((k ?? {}) as Record<string, string[]>).flatMap(([id, v]) => v.map(x => `${id}|${x}`)))

// ---------- propose: facts for the proposer, nothing enforceable ----------
function propose(): string {
  const base = ['src', 'lib', '.'].find(b => exists(path.join(ROOT, b))) ?? '.'
  const top = (dir: string): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).filter(e => e.isDirectory() && !/^(\.|node_modules|__)/.test(e.name)).map(e => e.name)
  let dirs = top(base)
  const only = dirs.length === 1 && exists(path.join(ROOT, base, dirs[0] as string, '__init__.py'))
  const parent = only ? `${base}/${dirs[0]}` : base
  if (only) dirs = top(parent)
  const edges: Record<string, Set<string>> = {}
  const walk = (dir: string, from: string): void => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(`${dir}/${e.name}`, from); continue }
      if (!/\.(py|[cm]?[jt]sx?)$/.test(e.name)) continue
      for (const line of read(path.join(ROOT, dir, e.name)).split('\n').filter(l => /^\s*(import|from|export)\b|\brequire\s*\(/.test(l)))
        for (const o of dirs.filter(o => o !== from && new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(o)}($|[^A-Za-z0-9_])`).test(line))) (edges[from] ??= new Set()).add(o)
    }
  }
  for (const d of dirs) walk(`${parent}/${d}`, d)
  const body = [...dirs.map(d => `layer ${d} ${parent}/${d}/**`), ...dirs.filter(d => edges[d]?.size).map(d => `allow ${d} -> ${[...(edges[d] ?? [])].join(', ')}`)]
  return ['Observed today (every import between these directories is listed as allowed; remove the edges that are mistakes):', '', '```rig-layers', ...body, '```', '', 'Put the edited block under "## Layers" in .rig/product/architecture.md, then the person runs `sdlc.ts arch approve`.'].join('\n')
}

export function cmdArch(args: Args): void {
  const sub = args.pos[0]
  const raw = parseLayers(read(path.join(ROOT, ARCH_REL)))
  const problems = raw.def ? [...raw.errors, ...validateLayers(raw.def)] : []
  const notes = raw.def ? missingDirs(raw.def, p => exists(path.join(ROOT, p))) : []
  const stack = parseRegistry(read(SENSORS_PATH)).registry.stack ?? ''
  if (sub === 'propose') return out(propose())
  if (sub === 'gen') {
    if (!raw.def) return out(`layers: not configured. Run \`sdlc.ts arch propose\`, put the block under "## Layers" in ${ARCH_REL}, then a person approves it.`)
    return out([`layers: ${layerStateText(layerState())}`, ...problems.map(p => `[layers] ${p}`), ...notes.map(n => `[layers] note: ${n}`), ...(problems.length ? [] : deriveLayering(raw.def).map(l => `  ${l.from} must not import ${l.mustNotImport.join(', ')}`))].join('\n'))
  }
  if (sub === 'approve') {
    if (process.env.SDLC_HUMAN !== '1') fail('layer approvals are human-only: the person runs `! SDLC_HUMAN=1 node .rig/bin/sdlc.ts arch approve`', 3)
    if (!raw.def) fail(`no \`\`\`rig-layers block under "## Layers" in ${ARCH_REL}: run \`sdlc.ts arch propose\``)
    if (problems.length) fail(problems.map(p => `[layers] ${p}`).join('\n'))
    let tool = toolOf(stack)
    const notes: string[] = [...missingDirs(raw.def, p => exists(path.join(ROOT, p))).map(n => `note: ${n}`)]
    if (tool && raw.def.layers.some(l => !l.glob.startsWith(`${tool?.root}/`))) {
      notes.push(`the ${tool.analyser} commit check scans ${tool.root}/ only, and a layer lives elsewhere, so no analyser config was written and only the edit-time sensor enforces; keep layers under ${tool.root}/`)
      tool = null
    }
    const rec: Record_ = { by: ownerOrFail(args, 'layer approvals'), at: new Date().toISOString(), blockHash: sha(raw.block), analyser: tool?.analyser ?? null, def: raw.def, layers: deriveLayering(raw.def) }
    const oldCfg = tool ? read(path.join(ROOT, tool.config)) : ''
    const hadRecord = readRecord() !== null
    const oldKeys = new Set(keysOf(readJson<unknown>(path.join(ROOT, KNOWN), [])))
    let known: unknown = []
    const undo = (): void => { if (!tool) return; if (oldCfg) writeAtomic(path.join(ROOT, tool.config), oldCfg); else fs.rmSync(path.join(ROOT, tool.config), { force: true }) }
    const taken = (r: { missing: boolean; failed: string | null }): boolean => {
      if (r.failed) { undo(); fail(`approval refused: ${tool?.analyser} failed (${r.failed}); fix the analyser or the block and re-run approve`) }
       if (r.missing && tool) notes.push(`${tool.analyser} is not installed, so no baseline was taken and the commit check will fail until it is: ${tool.install}, then re-run approve`); return !r.missing }
    if (tool?.analyser === 'dependency-cruiser') {
      writeAtomic(path.join(ROOT, tool.config), renderDepcruise(raw.def))
      const r = baselineRun(tool, raw.def)
      if (taken(r)) { try { known = JSON.parse(r.text) } catch { notes.push('the baseline could not be read; re-run approve') } }
    } else if (tool?.analyser === 'import-linter') {
      const ini = renderImportLinter(raw.def)
      if (!ini) notes.push('a layer glob does not map to one Python package, so only the edit-time sensor enforces; use layers under one src/<package>/')
      else {
        writeAtomic(path.join(ROOT, tool.config), ini)
        const r = baselineRun(tool, raw.def)
        if (taken(r)) { known = pythonViolations(r.text, raw.def); writeAtomic(path.join(ROOT, tool.config), renderImportLinter(raw.def, known as Record<string, string[]>) as string) }
      }
    } else notes.push(`no analyser data for stack "${stack || 'unknown'}": only the edit-time sensor enforces`)
    const grown = keysOf(known).filter(k => !oldKeys.has(k))
    if (hadRecord && grown.length && !args.opt.rebaseline) {
      undo()
      fail(`approval refused: ${grown.length} violation(s) are not in the previous baseline, so approving would grow it. Fix them first (a renamed layer also looks new: pass --rebaseline to accept them):\n${grown.slice(0, 5).map(g => `  ${g}`).join('\n')}`)
    }
    writeAtomic(path.join(ROOT, KNOWN), JSON.stringify(known, null, 2) + '\n')
    writeAtomic(path.join(ROOT, APPROVED), JSON.stringify(rec, null, 2) + '\n')
    sanctionWrites([APPROVED, KNOWN, ...(tool ? [tool.config] : [])])
    return out([`layers approved by ${rec.by}: ${rec.layers.length} layer rule(s) enforced; ${keysOf(known).length} existing violation(s) baselined`, ...notes,
      'The "layers" command sensor runs the analyser at commit. A repo initialised before arch existed needs the pack\'s current "layers" command from templates/stacks/.'].join('\n'))
  }
  fail('usage: arch (propose | gen | approve)')
}
