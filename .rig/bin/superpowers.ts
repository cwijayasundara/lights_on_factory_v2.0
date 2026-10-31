// rig's start, plan and chart skills run superpowers skills (native first, no copy of them). Whether the plugin is usable here
// is read from the plugin registry and the project's settings, so a missing plugin is a warning line, not "skill not found".
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, read } from './core.ts'

export const SUPERPOWERS = 'superpowers@claude-plugins-official'
export const SUPERPOWERS_INSTALL = `/plugin install ${SUPERPOWERS}`

type Entry = { scope?: string; projectPath?: string }
const json = (file: string): Record<string, unknown> => { try { return JSON.parse(read(file) || '{}') as Record<string, unknown> } catch { return {} } }

const real = (p: string): string => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
const same = (a: string, b: string): boolean => (process.platform === 'win32' ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b))

// 'ok', 'missing' (no install covers this repo) or 'disabled' (installed, switched off by the settings that apply: the user's, then
// the project's, then the project's local file, each overriding the one before).
export function superpowersState(root = ROOT, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')): 'ok' | 'missing' | 'disabled' {
  const plugins = (json(path.join(home, 'plugins', 'installed_plugins.json')).plugins ?? {}) as Record<string, Entry[]>
  const covers = (plugins[SUPERPOWERS] ?? []).some(e => e.scope === 'user' || e.scope === 'managed' || (e.projectPath !== undefined && same(e.projectPath, root)))
  if (!covers) return 'missing'
  let enabled: boolean | undefined
  for (const f of [path.join(home, 'settings.json'), path.join(root, '.claude/settings.json'), path.join(root, '.claude/settings.local.json')]) {
    const v = (json(f).enabledPlugins as Record<string, boolean> | undefined)?.[SUPERPOWERS]
    if (typeof v === 'boolean') enabled = v
  }
  return enabled === false ? 'disabled' : 'ok'
}

// One line for the skills: empty when superpowers is usable.
export function superpowersWarning(root?: string, home?: string): string {
  const state = superpowersState(root, home)
  if (state === 'ok') return ''
  return `WARNING: superpowers is ${state === 'missing' ? 'not installed' : 'disabled in this repo'}, so the superpowers skills named below are skipped and rig's own rules for the step apply. Install it with ${SUPERPOWERS_INSTALL}.`
}
