// `sdlc readiness` (harness readiness 4.1): a deterministic score of whether this repo is ready for agents to work in unattended, from file and
// configuration checks only (no model, no network, the same answer every run). Binary criteria in four levels; the repo's level is the highest
// one where it passes at least 80% of that level's criteria and of every level below. Repo-level, not person-level: it names what to fix, never who.
import path from 'node:path'
import { ROOT, SENSORS_PATH, SDLC, WAIVERS, out, read, readJson, exists, git, readJsonl, waiverLive, skillRef, type Args, type Waiver } from './core.ts'
import { parseRegistry, type Registry } from './registry.ts'
import { layerState } from './arch.ts'
import { appStates } from './app.ts'
import { loadRatchets } from './counts.ts'
import { hooksState } from './githooks.ts'

export type Criterion = { id: string; level: 1 | 2 | 3 | 4; what: string; fix: string; ok: boolean }
export const GATE = 0.8

export function criteria(): Criterion[] {
  const reg: Registry = parseRegistry(read(SENSORS_PATH)).registry
  const has = (id: string): boolean => reg.sensors.some(s => s.id === id && s.cmd && s.enabled)
  const claude = read(path.join(ROOT, 'CLAUDE.md'))
  const hooks = hooksState().state === 'installed'
  const waivers = readJsonl<Waiver>(WAIVERS)
  // Existence alone would let an empty file satisfy a criterion: these need content.
  const filled = (rel: string): boolean => read(path.join(ROOT, rel)).trim().length > 0
  const owners = (read(path.join(ROOT, 'CODEOWNERS')) + '\n' + read(path.join(ROOT, '.github/CODEOWNERS'))).split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
  const wiki = Object.keys(readJson<object | null>(path.join(SDLC, 'wiki.json'), null) ?? {}).length > 0
  const c = (level: Criterion['level'], id: string, what: string, fix: string, ok: boolean): Criterion => ({ id, level, what, fix, ok })
  return [
    c(1, 'git', 'the repo is under git', '`git init`', git(['rev-parse', '--is-inside-work-tree']) === 'true'),
    c(1, 'rig', 'rig is initialised (.rig/sensors.json)', `\`${skillRef('init')}\``, exists(SENSORS_PATH)),
    c(1, 'unit', 'a unit-test command is a sensor', 'add a "unit" command sensor to .rig/sensors.json (the stack pack has one)', has('unit')),
    c(1, 'claude-md', 'CLAUDE.md carries the sensors\' guides', '`sdlc.ts sync`', claude.includes('rig:guides start')),
    c(1, 'readme', 'a README says what the project is', 'write README.md', exists(path.join(ROOT, 'README.md'))),
    c(2, 'lint', 'a lint command is a sensor', 'add a "lint" command sensor', has('lint')),
    c(2, 'types', 'a type-check or build command is a sensor', 'add a "types" command sensor', has('types')),
    c(2, 'architecture', 'architecture.md describes the design', `\`${skillRef('chart')}\`, or write .rig/product/architecture.md`, exists(path.join(SDLC, 'product/architecture.md'))),
    c(2, 'layers', 'the dependency layers are declared and a person approved them', `\`${skillRef('arch')}\`, then a person runs \`arch approve\``, layerState().state === 'approved'),
    c(2, 'review-rules', 'CLAUDE.md has review rules (## Review)', `\`${skillRef('init')}\` writes them`, /^## Review\b/m.test(claude)),
    c(3, 'ci', 'the rig CI check is installed', 'copy templates/rig-check.yml to .github/workflows/', exists(path.join(ROOT, '.github/workflows/rig-check.yml'))),
    c(3, 'hooks', 'the git hooks run the checks', '`sdlc.ts hooks install`', hooks),
    c(3, 'contracts', 'contract files are declared and checked', 'set "contracts" in .rig/sensors.json', reg.contracts.files.length > 0 || Boolean(reg.contracts.validate || reg.contracts.run)),
    c(3, 'journeys', 'the running app has an approved journey', `\`${skillRef('app')}\`, then a person runs \`app approve\``, appStates().some(a => a.state === 'current')),
    c(3, 'ratchets', 'a count ratchet holds a baseline', 'give a command sensor "ratchet": "down" (duplication ships in every pack)', Object.keys(loadRatchets(read(path.join(SDLC, 'ratchets.json')))).length > 0),
    c(3, 'codeowners', 'CODEOWNERS covers .rig', 'copy templates/CODEOWNERS', owners.some(l => /^\S*\.rig\//.test(l.trim()))),
    c(4, 'lessons', 'the learning loop has a lessons file', `\`${skillRef('learn')}\``, filled('.rig/lessons.md')),
    c(4, 'waivers', 'every waiver has an owner and none has lapsed unrenewed', 'renew or remove them (`sensors` lists each)', waivers.every(w => w.by && w.by !== 'unknown' && waiverLive(w))),
    c(4, 'wiki', 'the code wiki exists', `\`${skillRef('wiki')} init\``, wiki),
    c(4, 'maintain', 'Maintain has run at least once', 'schedule `sdlc.ts maintain`', exists(path.join(SDLC, 'maintain'))),
  ]
}

export function score(list: Criterion[]): { level: number; levels: { level: number; passed: number; total: number; ratio: number }[] } {
  const levels = ([1, 2, 3, 4] as const).map(level => { const here = list.filter(x => x.level === level); const passed = here.filter(x => x.ok).length; return { level, passed, total: here.length, ratio: here.length ? passed / here.length : 1 } })
  let level = 0
  for (const l of levels) { if (l.ratio >= GATE) level = l.level; else break }
  return { level, levels }
}

export function cmdReadiness(args: Args): void {
  const list = criteria(), s = score(list)
  const min = typeof args.opt['min-level'] === 'string' ? Number(args.opt['min-level']) : null
  if (args.opt.json) out(JSON.stringify({ level: s.level, levels: s.levels, criteria: list }))
  else out([`readiness level ${s.level} of 4 (a level needs ${GATE * 100}% of its criteria and of every level below)`, ...s.levels.map(l => `  level ${l.level}: ${l.passed}/${l.total}`),
    ...(list.some(x => !x.ok) ? ['to fix, lowest level first:', ...list.filter(x => !x.ok).sort((a, b) => a.level - b.level).map(x => `  L${x.level} ${x.id}: ${x.what}: ${x.fix}`)] : [])].join('\n'))
  if (min !== null && s.level < min) process.exitCode = 1
}
