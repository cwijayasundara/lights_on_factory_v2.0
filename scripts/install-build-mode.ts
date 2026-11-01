import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type BuildModeOptions = { target: string; factoryRoot: string; profile?: string; demo: string }

type HookEntry = { type: string; command: string; timeout?: number }
type HookGroup = { matcher?: string; hooks: HookEntry[] }
type Settings = {
  permissions?: { allow?: string[]; deny?: string[]; [key: string]: unknown }
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}
type Gate = { name: string; run: string; timeoutSeconds: number }

const INSTALL_SUBJECT = 'chore: install build mode'
const IGNORED = ['.factory/build-state.json', '.factory/hook-log.jsonl', '.metrics/', 'target/']
const STOP_SLACK_SECONDS = 300

function fail(message: string): never {
  throw new Error(message)
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.status}`)
  return result.stdout.trim()
}

function realish(p: string): string {
  const resolved = path.resolve(p)
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
}

function checkTarget(factoryRoot: string, target: string): string {
  const root = realish(factoryRoot)
  const into = realish(target)
  if (into === root || into.startsWith(root + path.sep)) {
    fail(`refusing to install build mode into the factory repository itself (${into})`)
  }
  let top: string | null = null
  try {
    top = fs.realpathSync(git(into, ['rev-parse', '--show-toplevel']))
  } catch {
    top = null
  }
  if (top !== into) fail(`${into} is not the root of a git checkout`)
  if (git(into, ['status', '--porcelain', '--untracked-files=all']) !== '') fail(`${into} has uncommitted changes; commit or stash them first`)
  if (!fs.existsSync(path.join(into, 'SPEC.md'))) fail(`${into} has no SPEC.md; build mode builds from a spec`)
  return into
}

function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const source = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      copyTree(source, dest)
      continue
    }
    fs.mkdirSync(to, { recursive: true })
    fs.copyFileSync(source, dest)
    fs.chmodSync(dest, fs.statSync(source).mode & 0o777)
  }
}

function writeIfChanged(file: string, content: string): void {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function writeConfig(factoryRoot: string, target: string, profile: string, demo: string): Gate[] {
  const config = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'build-mode/profiles', profile, 'build.json'), 'utf8'))
  config.demo.run = demo
  writeIfChanged(path.join(target, '.factory/build.json'), `${JSON.stringify(config, null, 2)}\n`)
  return [...config.gates, config.demo]
}

function mergeSettings(factoryRoot: string, target: string, stopTimeout: number): void {
  const template = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'build-mode/settings.json'), 'utf8')) as Settings
  const file = path.join(target, '.claude/settings.json')
  const settings = (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}) as Settings
  const permissions = (settings.permissions ??= {})
  const union = (current: string[] = [], extra: string[] = []) => [...new Set([...current, ...extra])]
  permissions.allow = union(permissions.allow, template.permissions?.allow)
  permissions.deny = union(permissions.deny, template.permissions?.deny)
  settings.hooks ??= {}
  for (const [event, groups] of Object.entries(template.hooks ?? {})) {
    const existing = (settings.hooks[event] ??= [])
    for (const group of groups) {
      const command = group.hooks[0].command
      const timeout = event === 'Stop' ? stopTimeout : group.hooks[0].timeout
      const present = existing.find(g => g.hooks.some(h => h.command === command))
      const entry: HookGroup = { ...group, hooks: [{ ...group.hooks[0], timeout }] }
      if (present) Object.assign(present, entry)
      else existing.unshift(entry)
    }
  }
  writeIfChanged(file, `${JSON.stringify(settings, null, 2)}\n`)
}

function ensureIgnored(target: string): void {
  const file = path.join(target, '.gitignore')
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = current.split('\n')
  const missing = IGNORED.filter(line => !lines.includes(line))
  if (missing.length === 0) return
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`
  fs.writeFileSync(file, `${prefix}# build mode\n${missing.join('\n')}\n`)
}

function latestInstall(target: string): string {
  return git(target, ['log', '-1', '--format=%H', `--grep=^${INSTALL_SUBJECT}$`, '--', '.factory/build.json'])
}

export function installBuildMode(options: BuildModeOptions): { installCommit: string } {
  const profile = options.profile ?? 'python-uv'
  if (!options.demo) fail('a demo command is required (--demo)')
  const target = checkTarget(options.factoryRoot, options.target)
  const buildMode = path.join(options.factoryRoot, 'build-mode')
  if (!fs.existsSync(path.join(buildMode, 'profiles', profile))) fail(`unknown profile "${profile}"`)

  copyTree(path.join(buildMode, 'template'), target)
  copyTree(path.join(buildMode, 'profiles', profile, 'gates'), path.join(target, '.factory/gates'))
  const gates = writeConfig(options.factoryRoot, target, profile, options.demo)
  if (!fs.existsSync(path.join(target, '.factory/isolation'))) fs.writeFileSync(path.join(target, '.factory/isolation'), 'setting-sources\n')
  const stopTimeout = gates.reduce((sum, gate) => sum + gate.timeoutSeconds, 0) + STOP_SLACK_SECONDS
  mergeSettings(options.factoryRoot, target, stopTimeout)
  ensureIgnored(target)

  if (git(target, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    git(target, ['add', '-A'])
    git(target, ['commit', '-q', '-m', INSTALL_SUBJECT])
  }
  const installCommit = latestInstall(target)
  if (!installCommit) fail('no install commit found after installing')
  return { installCommit }
}

function main(argv: string[]): number {
  const [target, ...rest] = argv
  const demoIndex = rest.indexOf('--demo')
  const profileIndex = rest.indexOf('--profile')
  const demo = demoIndex >= 0 ? rest[demoIndex + 1] : undefined
  if (!target || !demo) {
    process.stderr.write('usage: node scripts/install-build-mode.ts <target> --demo "<command>" [--profile python-uv]\n')
    return 2
  }
  const factoryRoot = path.resolve(import.meta.dirname, '..')
  try {
    const profile = profileIndex >= 0 ? rest[profileIndex + 1] : undefined
    const { installCommit } = installBuildMode({ target, factoryRoot, demo, profile })
    const dir = realish(target)
    process.stdout.write(`installed build mode into ${dir} at ${installCommit.slice(0, 7)}\n`)
    process.stdout.write(`start: cd ${dir} && .factory/start-build.sh\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2))
