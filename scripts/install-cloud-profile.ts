import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type InstallOptions = {
  target: string
  factoryRoot: string
  // undefined reads RIG_SOURCE; null forces the pinned fetch/cache.
  rigSource?: string | null
  cacheRoot?: string
}

export type Pin = { repository: string; commit: string; version: string }

const FETCH_TIMEOUT_MS = 120_000

function fail(message: string): never {
  throw new Error(message)
}

function readPin(factoryRoot: string): Pin {
  const raw = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'cloud/rig-profile/pin.json'), 'utf8')) as Partial<Pin>
  return { repository: raw.repository ?? '', commit: raw.commit ?? '', version: raw.version ?? '' }
}

function validatePin(pin: Pin): void {
  if (!pin.repository) fail('pin repository is empty')
  if (!/^[0-9a-f]{40}$/.test(pin.commit)) fail(`pin commit must be a 40-character hex SHA, got "${pin.commit}"`)
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout: FETCH_TIMEOUT_MS,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.status}`)
  return result.stdout.trim()
}

// HEAD of the checkout rooted exactly at dir, or null when dir is not the root of a git checkout.
function checkoutHead(dir: string): string | null {
  try {
    if (fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel'])) !== fs.realpathSync(dir)) return null
    return git(dir, ['rev-parse', 'HEAD'])
  } catch {
    return null
  }
}

function useLocalCheckout(pin: Pin, rigSource: string): string {
  const dir = path.resolve(rigSource)
  const head = checkoutHead(dir)
  if (!head) fail(`RIG_SOURCE ${dir} is not the root of a git checkout`)
  if (head !== pin.commit) fail(`RIG_SOURCE ${dir} is at ${head}, but the pin is ${pin.commit}`)
  if (git(dir, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    fail(`RIG_SOURCE ${dir} has uncommitted changes or untracked files`)
  }
  return dir
}

function checkCache(cache: string, pin: Pin): string {
  const head = checkoutHead(cache)
  if (head !== pin.commit) {
    fail(`Rig cache ${cache} is at ${head ?? 'no commit'}, expected the pinned commit ${pin.commit}; delete it and retry`)
  }
  return cache
}

function fetchIntoCache(pin: Pin, cacheRoot: string, cache: string): string {
  fs.mkdirSync(cacheRoot, { recursive: true })
  const temp = fs.mkdtempSync(path.join(cacheRoot, '.tmp-'))
  try {
    git(temp, ['init', '-q'])
    git(temp, ['fetch', '-q', '--depth', '1', pin.repository, pin.commit])
    git(temp, ['checkout', '-q', '--detach', 'FETCH_HEAD'])
    if (git(temp, ['rev-parse', 'HEAD']) !== pin.commit) fail('fetched HEAD does not match the pin')
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true })
    fail(`could not fetch Rig ${pin.commit} from ${pin.repository}: ${(error as Error).message}`)
  }
  try {
    fs.renameSync(temp, cache)
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true })
    // Another install won the race; accept its cache only if it is at the pin.
    if (!fs.existsSync(cache)) throw error
  }
  return checkCache(cache, pin)
}

export function resolveRigSource(pin: Pin, options: { rigSource: string | null; cacheRoot: string }): string {
  validatePin(pin)
  if (options.rigSource) return useLocalCheckout(pin, options.rigSource)
  const cache = path.join(path.resolve(options.cacheRoot), pin.commit)
  if (fs.existsSync(cache)) return checkCache(cache, pin)
  return fetchIntoCache(pin, path.resolve(options.cacheRoot), cache)
}

function realish(p: string): string {
  const resolved = path.resolve(p)
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved
}

function refuseFactoryAsTarget(factoryRoot: string, target: string): void {
  const root = realish(factoryRoot)
  const into = realish(target)
  if (into === root || into.startsWith(root + path.sep)) {
    fail(`refusing to install the Rig profile into the factory repository itself (${into}); the factory is never a Rig target`)
  }
}

function copySetup(factoryRoot: string, target: string): void {
  const to = path.join(target, 'cloud/environment-setup.sh')
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(path.join(factoryRoot, 'cloud/environment-setup.sh'), to)
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
  if (present) return
  settings.hooks.SessionStart.unshift({
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command, timeout: 30 }],
  })
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
}

type Permissions = { defaultMode?: string; allow?: string[]; ask?: string[]; deny?: string[] }

// Merge the factory's unattended permission policy into the target; Rig's own rules stay.
function applyPermissionPolicy(factoryRoot: string, target: string): void {
  const policy = JSON.parse(fs.readFileSync(path.join(factoryRoot, 'cloud/rig-profile/permissions.json'), 'utf8')) as Permissions
  const file = path.join(target, '.claude/settings.json')
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: Permissions }
  const permissions = (settings.permissions ??= {})
  if (policy.defaultMode) permissions.defaultMode = policy.defaultMode
  const union = (current: string[] = [], extra: string[] = []) => [...new Set([...current, ...extra])]
  permissions.allow = union(permissions.allow, policy.allow)
  permissions.deny = union(permissions.deny, policy.deny)
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
  refuseFactoryAsTarget(options.factoryRoot, options.target)
  const pin = readPin(options.factoryRoot)
  const rigSource = options.rigSource === undefined ? process.env.RIG_SOURCE || null : options.rigSource
  const cacheRoot = options.cacheRoot ?? path.join(options.factoryRoot, '.cache/rig')
  const source = resolveRigSource(pin, { rigSource, cacheRoot })
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
  applyPermissionPolicy(options.factoryRoot, options.target)
  writeProvenance(options.target, source, pin)
  fs.rmSync(path.join(options.target, '.rig/.gate'), { force: true })
}

function main(argv: string[]): number {
  const [target] = argv
  if (!target) {
    process.stderr.write('usage: node scripts/install-cloud-profile.ts <target-repo>\n')
    return 2
  }
  const factoryRoot = path.resolve(import.meta.dirname, '..')
  try {
    installCloudProfile({ target, factoryRoot })
    const pin = readPin(factoryRoot)
    process.stdout.write(`installed Rig ${pin.version} (${pin.commit.slice(0, 7)}) into ${path.resolve(target)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2))
