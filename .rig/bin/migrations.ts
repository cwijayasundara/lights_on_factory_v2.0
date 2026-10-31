// rig:upgrade migrations: numbered, idempotent steps for changes a file copy cannot make. Each takes the repo root.
import fs from 'node:fs'
import path from 'node:path'
import { isRegistryShape } from './registry.ts'
import { detectedPackText } from './stackinit.ts'
import { older } from './vendor.ts'

export type Migration = { id: string; since: string; applies: (root: string) => boolean; run: (root: string) => string[] }

// Writes the detected pack's registry beside an old-shape sensors.json, for review. Never touches sensors.json itself.
const preRegistrySensors: Migration = {
  id: 'pre-registry-sensors',
  since: '0.6.0', // the plugin version this migration ships in (.claude-plugin/plugin.json)
  applies(root) {
    const file = path.join(root, '.rig', 'sensors.json')
    if (!fs.existsSync(file)) return false
    const text = fs.readFileSync(file, 'utf8')
    return text.trim() !== '{}' && !isRegistryShape(text) // `{}` is absent, as declareStack reads it
  },
  run(root) {
    const file = path.join(root, '.rig', 'sensors.json')
    if (!fs.existsSync(file) || isRegistryShape(fs.readFileSync(file, 'utf8'))) return []
    const text = detectedPackText(root)
    if (text === null) return ['.rig/sensors.json uses the pre-registry format and no stack pack matches this repo; write a registry yourself (see init --stack)']
    fs.writeFileSync(`${file}.rig-new`, text + '\n')
    return ['.rig/sensors.json uses the pre-registry format: proposed registry written to .rig/sensors.json.rig-new; review it, adjust the commands, and land it as a harness change']
  },
}

// 2026-10-27 one chart gate: `approve prd-N` is gone and the chart approval covers the conversion, so a PRD approval left by an
// older rig is a record nothing reads. It is removed so nobody takes it for a gate still to pass.
const sprintsDir = (root: string): string => path.join(root, '.rig', 'product', 'sprints')
const prdApprovals = (root: string): string[] => {
  try { return fs.readdirSync(sprintsDir(root)).map(d => path.join(sprintsDir(root), d, 'prd-approval.json')).filter(f => fs.existsSync(f)) } catch { return [] }
}
const dropPrdApproval: Migration = {
  id: 'drop-prd-approval',
  since: '0.7.0',
  applies: root => prdApprovals(root).length > 0,
  run(root) {
    return prdApprovals(root).map(f => { fs.rmSync(f); return `${path.relative(root, f).split(path.sep).join('/')} removed: the chart approval now covers prd.md, source.md and conversion.md` })
  },
}

export const MIGRATIONS: Migration[] = [preRegistrySensors, dropPrdApproval]

export const pendingMigrations = (installed: string, next: string): Migration[] => MIGRATIONS.filter(m => older(installed || '0.0.0', m.since) && !older(next, m.since))

export const runMigrations = (list: Migration[], root: string): string[] => list.flatMap(m => m.run(root))
