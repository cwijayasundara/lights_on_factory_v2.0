import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type BuildModeOptions = { target: string; factoryRoot: string; profile?: string; demo: string; acceptance?: boolean }

type HookEntry = { type: string; command: string; timeout?: number }
type HookGroup = { matcher?: string; hooks: HookEntry[] }
type Settings = {
  permissions?: { allow?: string[]; deny?: string[]; [key: string]: unknown }
  hooks?: Record<string, HookGroup[]>
  [key: string]: unknown
}
type Gate = { name: string; run: string; timeoutSeconds: number }

const INSTALL_SUBJECT = 'chore: install build mode'
const IGNORED = ['.fix-mode', '.factory/build-state.json', '.factory/hook-log.jsonl', '.factory/runs/', '.metrics/', 'target/']
const STOP_SLACK_SECONDS = 300
const OUR_HOOKS = [
  '.claude/hooks/build-gate.mjs',
  '.claude/hooks/protect-paths.mjs',
  '.claude/hooks/secret-guard.mjs',
  '.claude/hooks/fix-mode-guard.mjs',
  '.claude/hooks/post-edit-check.mjs',
]

// The Stop hook judges the build, so it runs the copy pinned at the install commit, never the
// working tree. If that copy cannot load or crashes, exit 2 blocks the stop instead of allowing it.
const PINNED_STOP = [
  'r="$CLAUDE_PROJECT_DIR"',
  'd=$(mktemp -d) || exit 2',
  `i=$(git -C "$r" log -1 --format=%H "--grep=^${INSTALL_SUBJECT}\$" -- .factory/build.json)`,
  'if [ -z "$i" ] || ! git -C "$r" archive "$i" .claude/hooks | tar -x -C "$d"; then echo "build mode: cannot load the Stop hook from the install commit" >&2; rm -rf "$d"; exit 2; fi',
  'node "$d/.claude/hooks/build-gate.mjs" stop; s=$?',
  'rm -rf "$d"',
  'if [ "$s" -ne 0 ]; then echo "build mode: the Stop hook crashed (exit $s)" >&2; exit 2; fi',
].join('; ')

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

function filesUnder(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__pycache__') return []
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(full, base) : [path.relative(base, full)]
  })
}

// Changes whenever anything the installer copies changes, so a hook-only upgrade still
// produces a new install commit touching build.json.
function templateHash(buildMode: string, profile: string): string {
  const hash = createHash('sha256')
  const roots = ['template', `profiles/${profile}`, 'settings.json']
  for (const root of roots) {
    const full = path.join(buildMode, root)
    const files = fs.statSync(full).isDirectory() ? filesUnder(full).sort().map(f => path.join(root, f)) : [root]
    for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(buildMode, file))).update('\0')
  }
  return hash.digest('hex')
}

function writeConfig(factoryRoot: string, target: string, profile: string, demo: string): Gate[] {
  const buildMode = path.join(factoryRoot, 'build-mode')
  const config = JSON.parse(fs.readFileSync(path.join(buildMode, 'profiles', profile, 'build.json'), 'utf8'))
  config.demo.run = demo
  // The suite is written in the shape phase; with none present there is nothing to run.
  if (!fs.existsSync(path.join(target, 'acceptance'))) delete config.acceptance
  config.templateHash = templateHash(buildMode, profile)
  writeIfChanged(path.join(target, '.factory/build.json'), `${JSON.stringify(config, null, 2)}\n`)
  return [...config.gates, ...(config.acceptance ? [config.acceptance] : []), config.demo]
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
    // Drop earlier build-mode entries (keeping the user's own hooks), then add the current ones.
    const kept = (settings.hooks[event] ?? [])
      .map(group => ({ ...group, hooks: group.hooks.filter(h => !OUR_HOOKS.some(ours => h.command.includes(ours))) }))
      .filter(group => group.hooks.length > 0)
    const ours = groups.map(group => {
      const hook = group.hooks[0]
      const entry = event === 'Stop' ? { ...hook, command: PINNED_STOP, timeout: stopTimeout } : hook
      return { ...group, hooks: [entry] }
    })
    settings.hooks[event] = [...ours, ...kept]
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

// A fresh Claude Code session that sees only the spec writes the acceptance suite, so the builder
// cannot share its reading of the spec. It may write only inside acceptance/ and cannot run anything.
export function runAcceptanceWriter(factoryRoot: string, target: string): number {
  const prompt = fs.readFileSync(path.join(factoryRoot, 'build-mode/acceptance/writer-prompt.txt'), 'utf8').trim()
  const claude = process.env.LIGHTS_ON_CLAUDE ?? 'claude'
  const args = [
    '-p',
    prompt,
    '--setting-sources',
    'project',
    '--allowedTools',
    'Read,Glob,Grep,Write(acceptance/**),Edit(acceptance/**)',
    '--disallowedTools',
    'Bash,Read(src/**),Read(tests/**)',
    '--max-budget-usd',
    '5',
    ...(process.env.LIGHTS_ON_ACCEPTANCE_MODEL ? ['--model', process.env.LIGHTS_ON_ACCEPTANCE_MODEL] : []),
  ]
  const result = spawnSync(claude, args, { cwd: target, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const discard = () => fs.rmSync(path.join(target, 'acceptance'), { recursive: true, force: true })
  if (result.error) fail(`could not start the acceptance writer (${claude}): ${result.error.message}`)
  if (result.status !== 0) {
    discard()
    fail(`acceptance writer exited ${result.status}: ${(result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n')}`)
  }
  const outside = git(target, ['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .filter(line => line && !line.slice(3).startsWith('acceptance/'))
  if (outside.length > 0) {
    discard()
    fail(`acceptance writer changed files outside acceptance/:\n${outside.join('\n')}`)
  }
  const tests = fs.existsSync(path.join(target, 'acceptance')) ? filesUnder(path.join(target, 'acceptance')).filter(f => /(^|\/)test_[^/]*\.py$/.test(f)) : []
  if (tests.length === 0) {
    discard()
    fail('the acceptance writer wrote no acceptance/test_*.py; check that SPEC.md has an Acceptance examples section')
  }
  return tests.length
}

function writeAcceptance(factoryRoot: string, target: string): number {
  return fs.existsSync(path.join(target, 'acceptance')) ? 0 : runAcceptanceWriter(factoryRoot, target)
}

function latestInstall(target: string): string {
  return git(target, ['log', '-1', '--format=%H', `--grep=^${INSTALL_SUBJECT}$`, '--', '.factory/build.json'])
}

export function installBuildMode(options: BuildModeOptions): { installCommit: string; acceptanceFiles: number } {
  const profile = options.profile ?? 'python-uv'
  if (!options.demo) fail('a demo command is required (--demo)')
  const target = checkTarget(options.factoryRoot, options.target)
  const buildMode = path.join(options.factoryRoot, 'build-mode')
  if (!fs.existsSync(path.join(buildMode, 'profiles', profile))) fail(`unknown profile "${profile}"`)

  const written = options.acceptance ? writeAcceptance(options.factoryRoot, target) : 0
  copyTree(path.join(buildMode, 'template'), target)
  copyTree(path.join(buildMode, 'profiles', profile, 'gates'), path.join(target, '.factory/gates'))
  const gates = writeConfig(options.factoryRoot, target, profile, options.demo)
  if (!fs.existsSync(path.join(target, '.factory/isolation'))) fs.writeFileSync(path.join(target, '.factory/isolation'), 'setting-sources\n')
  // The phase belongs to the target: a reinstall into a maintain repository keeps it.
  if (!fs.existsSync(path.join(target, '.factory/phase'))) fs.writeFileSync(path.join(target, '.factory/phase'), 'build\n')
  const stopTimeout = gates.reduce((sum, gate) => sum + gate.timeoutSeconds, 0) + STOP_SLACK_SECONDS
  mergeSettings(options.factoryRoot, target, stopTimeout)
  ensureIgnored(target)

  if (git(target, ['status', '--porcelain', '--untracked-files=all']) !== '') {
    git(target, ['add', '-A'])
    git(target, ['commit', '-q', '-m', INSTALL_SUBJECT])
  }
  const installCommit = latestInstall(target)
  if (!installCommit) fail('no install commit found after installing')
  return { installCommit, acceptanceFiles: written }
}

function main(argv: string[]): number {
  const [target, ...rest] = argv
  const demoIndex = rest.indexOf('--demo')
  const profileIndex = rest.indexOf('--profile')
  const acceptance = rest.includes('--acceptance')
  const demo = demoIndex >= 0 ? rest[demoIndex + 1] : undefined
  if (!target || !demo) {
    process.stderr.write('usage: node scripts/install-build-mode.ts <target> --demo "<command>" [--profile python-uv] [--acceptance]\n')
    return 2
  }
  const factoryRoot = path.resolve(import.meta.dirname, '..')
  try {
    const profile = profileIndex >= 0 ? rest[profileIndex + 1] : undefined
    const { installCommit, acceptanceFiles } = installBuildMode({ target, factoryRoot, demo, profile, acceptance })
    const dir = realish(target)
    process.stdout.write(`installed build mode into ${dir} at ${installCommit.slice(0, 7)}\n`)
    if (acceptanceFiles > 0) process.stdout.write(`acceptance suite written by a separate session: ${acceptanceFiles} file${acceptanceFiles === 1 ? '' : 's'}\n`)
    process.stdout.write(`start: cd ${dir} && .factory/start-build.sh\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2))
