// Stack packs (behavioural harness spec 2026-10-16 §4): per-language sensor defaults as data. Core never names a toolchain.
import fs from 'node:fs'
import path from 'node:path'
import { globToRegex, isObject, isStringList } from './model.ts'
import { parseRegistry, type Contracts, type Paths, type Registry } from './registry.ts'

type StackPack = { stack: string; markers: string[]; paths: Partial<Paths>; contracts: Contracts; sensors: unknown[] }
export const PACKS_DIR = path.resolve(import.meta.dirname, '../templates/stacks')
const PACK_KEYS = ['stack', 'markers', 'paths', 'contracts', 'sensors']

// The registry rig init writes for a pack: everything but the markers.
export const packFile = (p: StackPack): Record<string, unknown> => ({ stack: p.stack, paths: p.paths, contracts: p.contracts, sensors: p.sensors })
const registryText = (p: StackPack): string => JSON.stringify(packFile(p))

export function parsePack(text: string, file: string): { pack: StackPack | null; errors: string[] } {
  let v: unknown
  try { v = JSON.parse(text) } catch (e) { return { pack: null, errors: [`${file} does not parse: ${(e as Error).message}`] } }
  if (!isObject(v)) return { pack: null, errors: [`${file} must be a JSON object`] }
  const errors: string[] = []
  const name = path.basename(file, '.json')
  if (v.stack !== name) errors.push(`${file}: stack "${String(v.stack)}" does not match file ${file}`)
  if (!isStringList(v.markers) || !v.markers.length) errors.push(`${file}: markers must be a non-empty list of file names or globs`)
  if (!Array.isArray(v.sensors)) errors.push(`${file}: sensors must be a list`)
  else if (v.sensors.some(s => isObject(s) && s.builtin === true)) errors.push(`${file}: packs declare no built-in sensors`)
  for (const k of Object.keys(v)) if (!PACK_KEYS.includes(k)) errors.push(`${file}: unknown key "${k}"`)
  if (errors.length) return { pack: null, errors }
  const pack: StackPack = {
    stack: name,
    markers: v.markers as string[],
    paths: isObject(v.paths) ? (v.paths as Partial<Paths>) : {},
    contracts: isObject(v.contracts) ? { covers: [], ...(v.contracts as Partial<Contracts>) } as Contracts : { files: [], covers: [], validate: '', run: '' },
    sensors: v.sensors as unknown[],
  }
  const parsed = parseRegistry(registryText(pack))
  if (parsed.errors.length) return { pack: null, errors: parsed.errors.map(e => `${file}: ${e}`) }
  return { pack, errors: [] }
}

export function loadPacks(dir: string): { packs: StackPack[]; errors: string[] } {
  const packs: StackPack[] = []
  const errors: string[] = []
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
    const r = parsePack(fs.readFileSync(path.join(dir, f), 'utf8'), f)
    if (r.pack) packs.push(r.pack)
    errors.push(...r.errors)
  }
  return { packs, errors }
}

export function detectStacks(root: string, packs: StackPack[]): string[] {
  const entries = fs.existsSync(root) ? fs.readdirSync(root) : []
  const has = (m: string): boolean => (m.includes('*') ? entries.some(e => globToRegex(m).test(e)) : entries.includes(m))
  return packs.filter(p => p.markers.some(has)).map(p => p.stack)
}

export const packRegistry = (p: StackPack): Registry => parseRegistry(registryText(p)).registry
