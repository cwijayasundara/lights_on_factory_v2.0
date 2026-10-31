import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

type Pin = { repository: string; commit: string; version: string }
type InstallOptions = { target: string; factoryRoot: string; rigSource?: string | null; cacheRoot?: string }
type Installer = {
  installCloudProfile: (options: InstallOptions) => void
  resolveRigSource: (pin: Pin, options: { rigSource: string | null; cacheRoot: string }) => string
}

delete process.env.RIG_SOURCE

async function installer(): Promise<Installer> {
  return await import('../../scripts/install-cloud-profile.ts') as Installer
}

async function installCloudProfile(options: InstallOptions): Promise<void> {
  ;(await installer()).installCloudProfile(options)
}

async function resolveRigSource(pin: Pin, options: { rigSource: string | null; cacheRoot: string }): Promise<string> {
  return (await installer()).resolveRigSource(pin, options)
}

const repoRoot = path.resolve(import.meta.dirname, '../..')
const pinCommit = 'f33015bf12e711be7441eca45fefb177fd5d81cc'
const pinFile = JSON.parse(fs.readFileSync(path.join(repoRoot, 'cloud/rig-profile/pin.json'), 'utf8')) as Pin
const repoCache = path.join(repoRoot, '.cache/rig', pinCommit)
const expectedSkills = ['rig-chart', 'rig-plan', 'rig-build', 'rig-pr']
const oldCopyName = ['factory', 'rig'].join('-')

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: options.env, input: options.input })
}

function git(cwd: string, ...args: string[]): string {
  const result = run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// A minimal Rig-shaped git repository with two commits; returns both SHAs.
function rigFixture(version = '0.7.0'): { dir: string; first: string; second: string } {
  const dir = tmp('rig-fixture-')
  git(dir, 'init', '-q')
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  fs.mkdirSync(path.join(dir, '.claude-plugin'))
  fs.mkdirSync(path.join(dir, 'scripts'))
  fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'rig', version }))
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT fixture\n')
  fs.writeFileSync(path.join(dir, 'scripts/sdlc.ts'), 'process.exit(0)\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'one')
  const first = git(dir, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(dir, 'scripts/risk.ts'), 'export {}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'two')
  const second = git(dir, 'rev-parse', 'HEAD')
  return { dir, first, second }
}

function leftovers(cacheRoot: string): string[] {
  return fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).filter(name => name.startsWith('.tmp-')) : []
}

async function installInto(target: string, rigSource: string | null = null, cacheRoot?: string) {
  await installCloudProfile({ target, factoryRoot: repoRoot, rigSource, cacheRoot })
}

function hookCommands(target: string): string[] {
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>
  }
  return Object.values(settings.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)))
}

function expand(command: string, target: string): string {
  return command.replaceAll('$CLAUDE_PROJECT_DIR', target).replaceAll('"$CLAUDE_PROJECT_DIR"', `"${target}"`)
}

test('B1: a pin with a bad commit or an empty repository is refused, naming the field', async () => {
  const cacheRoot = tmp('rig-cache-')
  await assert.rejects(resolveRigSource({ ...pinFile, commit: 'abc' }, { rigSource: null, cacheRoot }), /commit/)
  await assert.rejects(resolveRigSource({ ...pinFile, repository: '' }, { rigSource: null, cacheRoot }), /repository/)
  assert.deepEqual(Object.keys(pinFile).sort(), ['commit', 'repository', 'version'])
})

test('B2/B3: a fixture fetch creates the cache at the pinned commit, leaves no temp dir, and is reused offline', async () => {
  const fixture = rigFixture()
  const cacheRoot = tmp('rig-cache-')
  const pin = { repository: fixture.dir, commit: fixture.first, version: '0.7.0' }
  const resolved = await resolveRigSource(pin, { rigSource: null, cacheRoot })
  assert.equal(resolved, path.join(cacheRoot, fixture.first))
  assert.equal(git(resolved, 'rev-parse', 'HEAD'), fixture.first)
  assert.deepEqual(leftovers(cacheRoot), [])
  const offline = { ...pin, repository: path.join(cacheRoot, 'no-such-repo') }
  assert.equal(await resolveRigSource(offline, { rigSource: null, cacheRoot }), resolved)
})

test('B4: a cache dir at another commit is refused and kept', async () => {
  const fixture = rigFixture()
  const cacheRoot = tmp('rig-cache-')
  const stale = path.join(cacheRoot, fixture.first)
  git(cacheRoot, 'clone', '-q', fixture.dir, stale)
  const pin = { repository: fixture.dir, commit: fixture.first, version: '0.7.0' }
  await assert.rejects(resolveRigSource(pin, { rigSource: null, cacheRoot }), (error: Error) => {
    assert.match(error.message, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(error.message, new RegExp(fixture.first))
    assert.match(error.message, new RegExp(fixture.second))
    return true
  })
  assert.equal(fs.existsSync(stale), true)
})

test('B5: an unreachable repository or unknown commit fails visibly and leaves nothing behind', async () => {
  const fixture = rigFixture()
  const missingCommit = 'deadbeef'.repeat(5)
  const cases: Pin[] = [
    { repository: path.join(tmp('rig-none-'), 'missing'), commit: fixture.first, version: '0.7.0' },
    { repository: fixture.dir, commit: missingCommit, version: '0.7.0' },
  ]
  for (const pin of cases) {
    const cacheRoot = tmp('rig-cache-')
    await assert.rejects(resolveRigSource(pin, { rigSource: null, cacheRoot }), (error: Error) => {
      assert.ok(error.message.includes(pin.repository), error.message)
      assert.ok(error.message.includes(pin.commit), error.message)
      return true
    })
    assert.equal(fs.existsSync(path.join(cacheRoot, pin.commit)), false)
    assert.deepEqual(leftovers(cacheRoot), [])
  }
})

test('B6/B7/B8: RIG_SOURCE is used only when clean and at the pinned commit', async () => {
  const fixture = rigFixture()
  const cacheRoot = tmp('rig-cache-')
  const atPin = { repository: 'https://example.invalid/rig', commit: fixture.second, version: '0.7.0' }
  assert.equal(await resolveRigSource(atPin, { rigSource: fixture.dir, cacheRoot }), fixture.dir)
  assert.deepEqual(fs.readdirSync(cacheRoot), [])

  const otherPin = { ...atPin, commit: fixture.first }
  await assert.rejects(resolveRigSource(otherPin, { rigSource: fixture.dir, cacheRoot }), (error: Error) => {
    assert.ok(error.message.includes(fixture.first) && error.message.includes(fixture.second), error.message)
    return true
  })

  fs.writeFileSync(path.join(fixture.dir, 'stray.txt'), 'x')
  await assert.rejects(resolveRigSource(atPin, { rigSource: fixture.dir, cacheRoot }), new RegExp(path.basename(fixture.dir)))
  fs.rmSync(path.join(fixture.dir, 'stray.txt'))
  fs.appendFileSync(path.join(fixture.dir, 'LICENSE'), 'edit\n')
  await assert.rejects(resolveRigSource(atPin, { rigSource: fixture.dir, cacheRoot }), new RegExp(path.basename(fixture.dir)))
})

test('B9: a source whose plugin version differs from the pin is refused', async () => {
  const fixture = rigFixture('9.9.9')
  const factoryRoot = tmp('rig-factory-')
  fs.mkdirSync(path.join(factoryRoot, 'cloud/rig-profile'), { recursive: true })
  fs.writeFileSync(
    path.join(factoryRoot, 'cloud/rig-profile/pin.json'),
    JSON.stringify({ repository: fixture.dir, commit: fixture.second, version: '0.7.0' }),
  )
  await assert.rejects(
    installCloudProfile({ target: tmp('rig-target-'), factoryRoot, rigSource: fixture.dir, cacheRoot: tmp('rig-cache-') }),
    /0\.7\.0[\s\S]*9\.9\.9/,
  )
})

test('B14: the factory is never a Rig target: no vendored Rig here, and the installer refuses itself as target', async () => {
  for (const entry of ['.rig', '.claude/agents/rig-evaluator.md', '.claude-plugin']) {
    assert.equal(fs.existsSync(path.join(repoRoot, entry)), false, entry)
  }
  const skills = path.join(repoRoot, '.claude/skills')
  const rigSkills = fs.existsSync(skills) ? fs.readdirSync(skills).filter(name => name.startsWith('rig-')) : []
  assert.deepEqual(rigSkills, [])
  const settings = fs.readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8')
  assert.doesNotMatch(settings, /sdlc\.ts|rig@/)
  await assert.rejects(
    installCloudProfile({ target: repoRoot, factoryRoot: repoRoot, rigSource: null }),
    /factory repository itself/,
  )
  await assert.rejects(
    installCloudProfile({ target: path.join(repoRoot, 'sub', '..'), factoryRoot: repoRoot, rigSource: null }),
    /factory repository itself/,
  )
})

test('B11: the pin has no copy field and the old local copy is gone', () => {
  const ignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8').split('\n')
  assert.ok(ignore.includes('.cache/'))
  assert.equal(fs.existsSync(path.join(repoRoot, oldCopyName)), false)
  for (const file of ['scripts/install-cloud-profile.ts', 'tests/profile/cloud-profile.test.mts']) {
    assert.equal(fs.readFileSync(path.join(repoRoot, file), 'utf8').includes(oldCopyName), false, file)
  }
})

test('B12: the docs record the pin, the path strategy, the source rule and the upstream rule', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'docs/cloud-compatibility.md'), 'utf8')
  assert.match(text, new RegExp(pinCommit))
  assert.match(text, /\$CLAUDE_PROJECT_DIR\/\.rig\/bin\/sdlc\.ts/)
  assert.match(text, /native cloud session was observed/i)
  assert.match(text, /session_012PjRkTZiSGP2nv4yUAp6SL/)
  assert.match(text, /PostToolUse:Write hook blocking error/)
  assert.match(text, /permission prompt/i)
  assert.match(text, /enabledPlugins/)
  assert.match(text, /CLAUDE_PLUGIN_ROOT/)
  assert.match(text, /RIG_SOURCE/)
  assert.match(text, /\.cache\/rig/)
  for (const file of [
    'docs/cloud-compatibility.md',
    'docs/superpowers/specs/2026-10-31-lights-on-factory-design.md',
    'docs/superpowers/plans/2026-10-31-lights-on-factory.md',
  ]) {
    const doc = fs.readFileSync(path.join(repoRoot, file), 'utf8')
    assert.match(doc, /upstream[^.]*rig_v1[^.]*pin/i, file)
    assert.equal(doc.includes(oldCopyName), false, file)
  }
})

test('B13: environment setup fails visibly when Node is missing or older than 22.18', () => {
  const script = path.join(repoRoot, 'cloud/environment-setup.sh')
  const bin = tmp('old-node-')
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho v20.11.0\n')
  fs.chmodSync(path.join(bin, 'node'), 0o755)
  const missing = run('bash', [script], { env: { ...process.env, PATH: '/usr/bin:/bin' } })
  const old = run('bash', [script], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` } })
  assert.notEqual(missing.status, 0)
  assert.match(`${missing.stderr}${missing.stdout}`, /Node\.js >= 22\.18/)
  assert.notEqual(old.status, 0)
  assert.match(`${old.stderr}${old.stdout}`, /v20\.11\.0/)
  assert.equal(run('bash', [script], { env: process.env }).status, 0)
  assert.equal(run('bash', [script], { env: process.env }).status, 0)
})

test('B2/B10/B13: a real install fetches the pin and resolves hooks and skills without the plugin root', async () => {
  const target = tmp('rig-profile-')
  run('git', ['init'], { cwd: target })
  await installInto(target)
  await installInto(target)
  assert.equal(git(repoCache, 'rev-parse', 'HEAD'), pinCommit)
  assert.equal(fs.existsSync(path.join(target, '.rig/.gate')), false)
  const commands = hookCommands(target)
  assert.ok(commands.length > 0)
  for (const command of commands) {
    assert.doesNotMatch(command, /CLAUDE_PLUGIN_ROOT/)
    if (command.includes('sdlc.ts')) {
      const script = expand(command, target).match(/"([^"]+\.rig\/bin\/sdlc\.ts)"/)?.[1]
        ?? expand(command, target).match(/(\S+\.rig\/bin\/sdlc\.ts)/)?.[1]
      assert.ok(script)
      assert.equal(fs.existsSync(script), true)
    }
    if (command.includes('environment-setup.sh')) {
      assert.equal(fs.existsSync(path.join(target, 'cloud/environment-setup.sh')), true)
    }
  }
  assert.ok(commands.some(command => command.includes('environment-setup.sh')))
  for (const skill of expectedSkills) {
    const text = fs.readFileSync(path.join(target, '.claude/skills', skill, 'SKILL.md'), 'utf8')
    assert.match(text, /\.rig\/bin\/sdlc\.ts/)
    assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT/)
  }
  assert.equal(
    fs.readFileSync(path.join(target, '.rig/bin/risk.ts'), 'utf8'),
    fs.readFileSync(path.join(repoCache, 'scripts/risk.ts'), 'utf8'),
  )
  const profile = JSON.parse(fs.readFileSync(path.join(target, '.rig/CLOUD_PROFILE.json'), 'utf8')) as Record<string, unknown>
  assert.equal('copy' in profile, false)
  assert.deepEqual(profile, pinFile)
  assert.equal(
    fs.readFileSync(path.join(target, '.rig/LICENSE'), 'utf8'),
    fs.readFileSync(path.join(repoCache, 'LICENSE'), 'utf8'),
  )
  const session = commands.find(command => command.includes('hook session-start'))
  assert.ok(session)
  for (let i = 0; i < 2; i++) {
    const result = run('bash', ['-lc', expand(session, target)], {
      cwd: target,
      env: { ...process.env, CLAUDE_PROJECT_DIR: target },
      input: '{}',
    })
    assert.equal(result.status, 0, result.stderr)
  }
})

test('P1: the unattended permission policy is merged into the target, keeping Rig rules, with no duplicates', async () => {
  const policy = JSON.parse(fs.readFileSync(path.join(repoRoot, 'cloud/rig-profile/permissions.json'), 'utf8')) as {
    defaultMode: string
    allow: string[]
    deny: string[]
  }
  assert.equal(policy.defaultMode, 'acceptEdits')
  for (const rule of ['Bash(git commit *)', 'Bash(git push *)', 'Bash(npm test)', 'Bash(npm ci)']) assert.ok(policy.allow.includes(rule), rule)
  for (const rule of ['Bash(curl *)', 'Bash(wget *)', 'Bash(git push --force*)', 'Bash(npm publish*)']) assert.ok(policy.deny.includes(rule), rule)
  assert.equal(policy.allow.some(rule => rule === 'Bash' || rule === 'Bash(*)'), false)

  const target = tmp('rig-policy-')
  run('git', ['init'], { cwd: target })
  await installInto(target)
  await installInto(target)
  const settings = JSON.parse(fs.readFileSync(path.join(target, '.claude/settings.json'), 'utf8')) as {
    permissions: { defaultMode?: string; allow: string[]; ask: string[]; deny: string[] }
  }
  const { permissions } = settings
  assert.equal(permissions.defaultMode, 'acceptEdits')
  for (const rule of policy.allow) assert.ok(permissions.allow.includes(rule), rule)
  for (const rule of policy.deny) assert.ok(permissions.deny.includes(rule), rule)
  assert.ok(permissions.allow.includes('Skill(rig-start)'))
  assert.ok(permissions.deny.includes('Edit(/.rig/changes/*/approval.json)'))
  assert.ok(permissions.ask.includes('Edit(/.claude/settings.json)'))
  for (const list of [permissions.allow, permissions.deny]) assert.equal(new Set(list).size, list.length)
})

test('B6: a clean RIG_SOURCE checkout at the pin is vendored without touching the cache', async () => {
  await installInto(tmp('rig-profile-'))
  const worktree = path.join(tmp('rig-worktree-'), 'rig')
  git(repoCache, 'worktree', 'add', '-q', '--detach', worktree, pinCommit)
  try {
    const cacheRoot = tmp('rig-cache-')
    const target = tmp('rig-profile-')
    run('git', ['init'], { cwd: target })
    await installInto(target, worktree, cacheRoot)
    assert.deepEqual(fs.readdirSync(cacheRoot), [])
    assert.equal(
      fs.readFileSync(path.join(target, '.rig/bin/risk.ts'), 'utf8'),
      fs.readFileSync(path.join(worktree, 'scripts/risk.ts'), 'utf8'),
    )
  } finally {
    git(repoCache, 'worktree', 'remove', '--force', worktree)
  }
})

test('CLI: install-cloud-profile.ts <target> installs into the target and refuses the factory itself', () => {
  const script = path.join(repoRoot, 'scripts/install-cloud-profile.ts')
  const node = [process.execPath, '--disable-warning=ExperimentalWarning', script]
  const target = tmp('rig-cli-')
  run('git', ['init'], { cwd: target })
  const ok = run(node[0], [...node.slice(1), target], { env: { ...process.env, RIG_SOURCE: '' } })
  assert.equal(ok.status, 0, ok.stderr)
  assert.equal(fs.existsSync(path.join(target, '.rig/bin/sdlc.ts')), true)
  assert.match(ok.stdout, /installed Rig 0\.7\.0/)
  const self = run(node[0], [...node.slice(1), repoRoot])
  assert.equal(self.status, 1)
  assert.match(self.stderr, /factory repository itself/)
  const none = run(node[0], node.slice(1))
  assert.equal(none.status, 2)
  assert.match(none.stderr, /usage/i)
})

test('B13: a missing checker and a forbidden edit both fail visibly', async () => {
  const target = tmp('rig-profile-')
  run('git', ['init'], { cwd: target })
  await installInto(target)
  const postEdit = hookCommands(target).find(command => command.includes('hook post-edit'))
  assert.ok(postEdit)
  fs.rmSync(path.join(target, '.rig/bin/sdlc.ts'))
  const missing = run('bash', ['-lc', expand(postEdit, target)], {
    cwd: target,
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: '{}',
  })
  assert.notEqual(missing.status, 0)
  assert.match(`${missing.stderr}${missing.stdout}`, /sdlc\.ts|Cannot find module|not found/i)

  await installInto(target)
  const secretFile = path.join(target, 'leaked.txt')
  fs.writeFileSync(secretFile, `key=${['AKIA', 'IOSFODNN7EXAMPLE'].join('')}\n`)
  const forbidden = run('bash', ['-lc', expand(postEdit, target)], {
    cwd: target,
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: JSON.stringify({ tool_input: { file_path: secretFile } }),
  })
  assert.equal(forbidden.status, 2)
  assert.match(forbidden.stderr, /sdlc check failed/)
})
