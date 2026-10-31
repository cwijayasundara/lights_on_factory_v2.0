// `init --stack`: onboarding-only sensor declarations: the detected stack pack written as the registry.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROOT, SENSORS_PATH, SENSORS_JSON, SDLC, PLUGIN_ROOT, exists, read, git, listChanges, sanctionWrites } from './core.ts'
import { loadPacks, detectStacks, packFile, packRegistry, PACKS_DIR } from './stackpacks.ts'
import { writeSync, BRIEF } from './sync.ts'
import { isRegistryShape, type Contracts } from './registry.ts'

// Specmatic runs on Java (spec §4): without java on PATH its commands would fail every gate, so init leaves them empty and says why.
export function packContracts(c: Contracts, javaOk: boolean): { contracts: Contracts; note: string } {
  if (javaOk || !/\bspecmatic\b/.test(`${c.validate} ${c.run}`)) return { contracts: c, note: '' }
  return { contracts: { ...c, validate: '', run: '' }, note: ' Contract commands left empty: java is not on PATH, and Specmatic runs on Java. Install a JRE, then set contracts.validate and contracts.run.' }
}
const javaOk = (): boolean => spawnSync('java', ['-version'], { stdio: 'ignore' }).status === 0

// `init --stack [name]`: with no sensors.json yet, write the detected stack pack as a registry. Onboarding only: it declares
// only while sensors.json is absent or `{}`, uncommitted, and no change exists, so it cannot launder an edit to a reviewed config.
// An old-shape file is a reviewed harness file: print the registry that replaces it, never overwrite it here.
function packsFor(opt: string | true, root: string = ROOT): { packs: ReturnType<typeof loadPacks>['packs']; found: string[] } {
  const { packs } = loadPacks(PACKS_DIR)
  return { packs, found: typeof opt === 'string' ? [opt] : detectStacks(root, packs) }
}

// The registry text of the one pack detected in `root`, or null when none or several match.
export function detectedPackText(root: string): string | null {
  const { packs, found } = packsFor(true, root)
  const pack = found.length === 1 ? packs.find(p => p.stack === found[0]) : undefined
  return pack ? JSON.stringify(packFile(pack), null, 2) : null
}

function upgradeText(opt: string | true): string {
  const { packs, found } = packsFor(opt)
  const pack = found.length === 1 ? packs.find(p => p.stack === found[0]) : undefined
  const head = '.rig/sensors.json uses the pre-registry format. Replace it with a registry and land that on the trunk as a reviewed harness change'
  return pack ? `${head}. From the ${pack.stack} pack, with the commands to adjust to this repo:\n${JSON.stringify(packFile(pack), null, 2)}` : `${head}; run init --stack <name> with one of: ${packs.map(p => p.stack).join(', ')}`
}

export function declareStack(opt: string | true): string {
  const file = SENSORS_PATH
  const text = exists(file) ? read(file).trim() : ''
  if (text && isRegistryShape(text)) return '.rig/sensors.json already exists; edit it'
  if (text && text !== '{}') return upgradeText(opt)
  if ((git(['ls-tree', '-r', '--name-only', 'HEAD']) ?? '').split('\n').includes(SENSORS_JSON)) return '.rig/sensors.json is committed; changing it is a reviewed harness edit, not onboarding'
  if (listChanges().length) return 'a change already exists; --stack is for onboarding only'
  const { packs, found } = packsFor(opt)
  if (found.length > 1) return `several stacks match (${found.sort().join(', ')}); run init --stack <name> with one of them`
  const pack = packs.find(p => p.stack === found[0])
  if (!pack) return `no stack pack for ${found[0] ?? 'this directory'} (known: ${packs.map(p => p.stack).join(', ')}); write .rig/sensors.json yourself`
  fs.mkdirSync(SDLC, { recursive: true })
  const pc = packContracts(pack.contracts, javaOk())
  fs.writeFileSync(file, JSON.stringify({ ...packFile(pack), contracts: pc.contracts }, null, 2) + '\n')
  sanctionWrites([SENSORS_JSON])
  const brief = path.join(ROOT, BRIEF)
  if (!exists(brief)) { fs.mkdirSync(path.dirname(brief), { recursive: true }); fs.copyFileSync(path.join(PLUGIN_ROOT, 'templates', 'brief.md'), brief) }
  const synced = writeSync(packRegistry(pack))
  return `wrote .rig/sensors.json from the ${pack.stack} pack (${pack.sensors.length} sensors); edit the commands to fit this repo. ${BRIEF} is ready to fill in. ${prdFolder()}${synced}${pc.note}`
}

// The suggested PRD folder, on disk so a person finds it (2026-10-26 tester feedback): a README and the template, never a sprint
// PRD (that would read as one written) and never over a file the repo already has.
function prdFolder(): string {
  const dir = path.join(ROOT, 'docs', 'prd')
  if (exists(dir) && !fs.statSync(dir).isDirectory()) return ''
  fs.mkdirSync(dir, { recursive: true })
  for (const [to, from] of [['README.md', 'prd-readme.md'], ['prd-template.md', 'prd-format.md']] as const) if (!exists(path.join(dir, to))) fs.copyFileSync(path.join(PLUGIN_ROOT, 'templates', from), path.join(dir, to))
  return `Put each sprint's PRD in docs/prd/sprint-<n>/prd.md (docs/prd/sprint-0/prd.md first; docs/prd/prd-template.md is the format). `
}
