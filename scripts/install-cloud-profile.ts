import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type InstallOptions = {
  rigRepo: string
  target: string
  factoryRoot: string
}

type Pin = { repository: string; commit: string; version: string }

function fail(message: string): never {
  throw new Error(message)
}

function readPin(factoryRoot: string): Pin {
  return JSON.parse(fs.readFileSync(path.join(factoryRoot, 'cloud/rig-profile/pin.json'), 'utf8')) as Pin
}

function materialize(rigRepo: string, commit: string): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pin-'))
  const archive = spawnSync('git', ['-C', rigRepo, 'archive', commit], { maxBuffer: 128 * 1024 * 1024 })
  if (archive.status !== 0) fail(`could not archive ${commit} from ${rigRepo}: ${archive.stderr.toString()}`)
  const extract = spawnSync('tar', ['-x', '-C', dest], { input: archive.stdout })
  if (extract.status !== 0) fail(`could not extract ${commit}: ${extract.stderr.toString()}`)
  return dest
}

function copySetup(factoryRoot: string, target: string): void {
  const from = path.join(factoryRoot, 'cloud/environment-setup.sh')
  const to = path.join(target, 'cloud/environment-setup.sh')
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (path.resolve(from) !== path.resolve(to)) fs.copyFileSync(from, to)
  fs.chmodSync(to, 0o755)
}

function ensureStartupHook(target: string): void {
  const file = path.join(target, '.claude/settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>
  }
  const command = 'bash "$CLAUDE_PROJECT_DIR/cloud/environment-setup.sh"'
  settings.hooks ??= {}
  settings.hooks.SessionStart ??= []
  const present = settings.hooks.SessionStart.some(group => group.hooks.some(hook => hook.command === command))
  if (!present) {
    settings.hooks.SessionStart.unshift({
      matcher: 'startup|resume|clear|compact',
      hooks: [{ type: 'command', command, timeout: 30 }],
    })
  }
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

function writeProvenance(target: string, source: string, pin: Pin): void {
  const license = path.join(source, 'LICENSE')
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(target, '.rig/LICENSE'))
  const next = `${JSON.stringify({ repository: pin.repository, commit: pin.commit, version: pin.version }, null, 2)}\n`
  const file = path.join(target, '.rig/CLOUD_PROFILE.json')
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== next) fs.writeFileSync(file, next)
}

export function installCloudProfile(options: InstallOptions): void {
  const pin = readPin(options.factoryRoot)
  const source = materialize(options.rigRepo, pin.commit)
  const plugin = JSON.parse(fs.readFileSync(path.join(source, '.claude-plugin/plugin.json'), 'utf8')) as { version?: string }
  if (plugin.version !== pin.version) fail(`pin version ${pin.version} does not match plugin.json ${plugin.version ?? 'unknown'}`)
  fs.mkdirSync(options.target, { recursive: true })
  const result = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', path.join(source, 'scripts/sdlc.ts'), 'vendor', '--standalone'],
    {
      cwd: source,
      env: { ...process.env, CLAUDE_PROJECT_DIR: path.resolve(options.target) },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (result.status !== 0) fail(`vendor --standalone failed:\n${result.stdout}\n${result.stderr}`)
  copySetup(options.factoryRoot, options.target)
  ensureStartupHook(options.target)
  writeProvenance(options.target, source, pin)
  fs.rmSync(path.join(options.target, '.rig/.gate'), { force: true })
}
