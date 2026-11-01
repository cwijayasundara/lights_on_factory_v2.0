import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

type Options = { target: string; factoryRoot: string; profile?: string; demo: string }
type Installer = { installBuildMode: (options: Options) => { installCommit: string } }

const factoryRoot = path.resolve(import.meta.dirname, '../..')
const installer = async () => (await import('../../scripts/install-build-mode.ts')) as Installer
const DEMO = 'uv run mini-agent demo'

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function target(files: Record<string, string> = { 'SPEC.md': '# Spec\n' }): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-build-')))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'docs: add the spec')
  return dir
}

async function install(dir: string, demo = DEMO) {
  return (await installer()).installBuildMode({ target: dir, factoryRoot, demo })
}

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))

test('installs into a fresh repo and the hooks resolve', async () => {
  const dir = target()
  const { installCommit } = await install(dir)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), installCommit)
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: install build mode')
  assert.equal(git(dir, 'status', '--porcelain'), '')
  for (const file of [
    '.claude/hooks/build-gate.mjs',
    '.claude/hooks/protect-paths.mjs',
    '.claude/hooks/lib/plan.mjs',
    '.claude/hooks/lib/decide.mjs',
    '.claude/skills/build-discipline/SKILL.md',
    '.factory/build-prompt.txt',
    '.factory/start-build.sh',
    '.factory/gates/_gate.py',
    '.factory/gates/mutate.py',
  ]) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} missing`)
  }
  assert.ok(!fs.existsSync(path.join(dir, '.factory/gates/__pycache__')))
  assert.equal(readJson(path.join(dir, '.factory/build.json')).demo.run, DEMO)
  assert.equal(fs.readFileSync(path.join(dir, '.factory/isolation'), 'utf8').trim(), 'setting-sources')
  const settings = readJson(path.join(dir, '.claude/settings.json'))
  const commands = Object.values(settings.hooks as Record<string, { hooks: { command: string; timeout: number }[] }[]>).flatMap(groups =>
    groups.flatMap(group => group.hooks.map(hook => hook.command)),
  )
  assert.ok(commands.some(command => command.includes('archive') && command.includes('build-gate.mjs" stop')))
  assert.ok(commands.includes('node "$CLAUDE_PROJECT_DIR/.claude/hooks/build-gate.mjs" session-start'))
  assert.ok(commands.includes('node "$CLAUDE_PROJECT_DIR/.claude/hooks/protect-paths.mjs"'))
  const gates = readJson(path.join(dir, '.factory/build.json')).gates as { timeoutSeconds: number }[]
  const budget = gates.reduce((sum, gate) => sum + gate.timeoutSeconds, 0) + 120 + 300
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, budget)
  assert.ok(settings.permissions.deny.includes('Bash(git push --force*)'))
  assert.ok(settings.permissions.deny.includes('Bash(git push *+*)'))
  assert.ok(settings.permissions.deny.includes('Bash(git reset *)'))
  assert.match(readJson(path.join(dir, '.factory/build.json')).templateHash, /^[0-9a-f]{64}$/)
  assert.ok(settings.permissions.allow.includes('Bash(uv *)'))
  const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')
  for (const line of ['.factory/build-state.json', '.factory/hook-log.jsonl', '.metrics/', 'target/']) assert.ok(ignore.split('\n').includes(line))

  const hook = spawnSync(process.execPath, [path.join(dir, '.claude/hooks/build-gate.mjs'), 'stop'], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
  })
  assert.equal(JSON.parse(hook.stdout).reason, 'write PLAN.md from SPEC.md')
})

test('refuses the factory itself', async () => {
  await assert.rejects(install(factoryRoot), /refusing to install build mode into the factory repository itself/)
})

test('refuses a dirty target before writing anything', async () => {
  const dir = target()
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'wip\n')
  await assert.rejects(install(dir), /has uncommitted changes/)
  assert.ok(!fs.existsSync(path.join(dir, '.factory')))
})

test('refuses a target without SPEC.md, and a directory that is not a git checkout root', async () => {
  await assert.rejects(install(target({ 'README.md': 'hi\n' })), /has no SPEC.md/)
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'))
  await assert.rejects(install(plain), /is not the root of a git checkout/)
})

test('a second install changes nothing and adds no duplicate hooks', async () => {
  const dir = target()
  const first = await install(dir)
  const second = await install(dir)
  assert.equal(second.installCommit, first.installCommit)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), first.installCommit)
  const settings = readJson(path.join(dir, '.claude/settings.json'))
  assert.equal(settings.hooks.Stop.length, 1)
  assert.equal(settings.hooks.PreToolUse.length, 1)
  assert.equal(new Set(settings.permissions.allow).size, settings.permissions.allow.length)
})

test('a reinstall with a new demo becomes the new install commit, so the hook does not flag it', async () => {
  const dir = target()
  await install(dir)
  const again = await install(dir, 'uv run toy demo')
  assert.equal(git(dir, 'rev-parse', 'HEAD'), again.installCommit)
  const hook = spawnSync(process.execPath, [path.join(dir, '.claude/hooks/build-gate.mjs'), 'stop'], {
    input: JSON.stringify({ cwd: dir }),
    encoding: 'utf8',
  })
  assert.equal(JSON.parse(hook.stdout).reason, 'write PLAN.md from SPEC.md')
})

test('keeps existing settings entries', async () => {
  const existing = { permissions: { allow: ['Bash(make *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'x' }
  const dir = target({ 'SPEC.md': '# Spec\n', '.claude/settings.json': JSON.stringify(existing) })
  await install(dir)
  const settings = readJson(path.join(dir, '.claude/settings.json'))
  assert.equal(settings.model, 'x')
  assert.ok(settings.permissions.allow.includes('Bash(make *)'))
  assert.equal(settings.hooks.Stop.length, 2)
})

test('the CLI prints the install commit and the start command', () => {
  const dir = target()
  const result = spawnSync(process.execPath, [path.join(factoryRoot, 'scripts/install-build-mode.ts'), dir, '--demo', DEMO], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const sha = git(dir, 'rev-parse', 'HEAD')
  assert.match(result.stdout, new RegExp(`installed build mode into ${dir} at ${sha.slice(0, 7)}`))
  assert.match(result.stdout, new RegExp(`start: cd ${dir} && \\.factory/start-build\\.sh`))
  const usage = spawnSync(process.execPath, [path.join(factoryRoot, 'scripts/install-build-mode.ts'), dir], { encoding: 'utf8' })
  assert.equal(usage.status, 2)
  assert.match(usage.stderr, /usage: node scripts\/install-build-mode.ts <target> --demo "<command>"/)
})

test('start-build.sh passes the prompt from build-prompt.txt, isolated by setting sources', async () => {
  const dir = target()
  await install(dir)
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-'))
  const record = path.join(bin, 'args.txt')
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\necho "CONFIG=\${CLAUDE_CONFIG_DIR:-unset}" >> "${record}"\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  delete env.CLAUDE_CONFIG_DIR
  const run = () => spawnSync(path.join(dir, '.factory/start-build.sh'), [], { cwd: path.join(dir, '.claude'), env, encoding: 'utf8' })
  assert.equal(run().status, 0)
  const prompt = fs.readFileSync(path.join(dir, '.factory/build-prompt.txt'), 'utf8').trim()
  assert.deepEqual(fs.readFileSync(record, 'utf8').trim().split('\n'), ['--setting-sources', 'project', '--permission-mode', 'auto', prompt, 'CONFIG=unset'])
  fs.writeFileSync(path.join(dir, '.factory/isolation'), 'config-dir\n')
  assert.equal(run().status, 0)
  assert.match(fs.readFileSync(record, 'utf8'), new RegExp(`CONFIG=${os.homedir()}/\\.claude-build`))
})

function stopCommand(dir: string): string {
  const settings = readJson(path.join(dir, '.claude/settings.json'))
  return settings.hooks.Stop[0].hooks[0].command as string
}

function runStop(dir: string, projectDir = dir) {
  return spawnSync('/bin/sh', ['-c', stopCommand(dir)], {
    input: JSON.stringify({ cwd: projectDir }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
  })
}

test('the Stop command runs the hook pinned at the install commit, not the working tree', async () => {
  const dir = target()
  await install(dir)
  fs.writeFileSync(path.join(dir, '.claude/hooks/lib/decide.mjs'), "export function decide() { return { kind: 'allow', header: 'COMPLETE' } }\n")
  const result = runStop(dir)
  assert.equal(result.status, 0, result.stderr)
  assert.match(JSON.parse(result.stdout).reason, /^restore the protected files[\s\S]*changed: \.claude\/hooks\/lib\/decide\.mjs/)
  fs.rmSync(path.join(dir, '.claude/hooks/lib'), { recursive: true })
  assert.match(JSON.parse(runStop(dir).stdout).reason, /deleted: \.claude\/hooks\/lib\/decide\.mjs/)
})

test('the Stop command blocks with exit 2 when it cannot load the pinned hook', async () => {
  const dir = target()
  await install(dir)
  const other = target()
  const result = runStop(dir, other)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /build mode: cannot load the Stop hook from the install commit/)
})

test('a reinstall that changes only a hook file becomes the new install commit', async () => {
  const copy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-copy-')))
  fs.cpSync(path.join(factoryRoot, 'build-mode'), path.join(copy, 'build-mode'), { recursive: true })
  const dir = target()
  const first = (await installer()).installBuildMode({ target: dir, factoryRoot: copy, demo: DEMO })
  fs.appendFileSync(path.join(copy, 'build-mode/template/.claude/hooks/protect-paths.mjs'), '// upgraded\n')
  const second = (await installer()).installBuildMode({ target: dir, factoryRoot: copy, demo: DEMO })
  assert.notEqual(second.installCommit, first.installCommit)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), second.installCommit)
  assert.equal(JSON.parse(runStop(dir).stdout).reason, 'write PLAN.md from SPEC.md')
})

test('the installer writes phase build once and leaves a later phase alone', async () => {
  const dir = target()
  await install(dir)
  const phase = path.join(dir, '.factory/phase')
  assert.equal(fs.readFileSync(phase, 'utf8'), 'build\n')
  fs.writeFileSync(phase, 'maintain\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: build complete, enter maintain')
  await install(dir)
  assert.equal(fs.readFileSync(phase, 'utf8'), 'maintain\n')
})

test('the profile marks tests, lint and types as the fast gates', () => {
  const config = readJson(path.join(factoryRoot, 'build-mode/profiles/python-uv/build.json'))
  const fast = config.gates.filter((gate: { level?: string }) => gate.level === 'fast').map((gate: { name: string }) => gate.name)
  assert.deepEqual(fast, ['tests', 'lint', 'types'])
})

test('the profile protects acceptance/ and names the test directories the guard polices', () => {
  const config = readJson(path.join(factoryRoot, 'build-mode/profiles/python-uv/build.json'))
  assert.ok(config.protected.includes('acceptance/'))
  assert.deepEqual(config.testPaths, ['tests/'])
})

test('an acceptance gate is configured only when the target has an acceptance/ directory', async () => {
  const without = target()
  await install(without)
  assert.equal(readJson(path.join(without, '.factory/build.json')).acceptance, undefined)

  const withSuite = target({ 'SPEC.md': '# Spec\n', 'acceptance/test_demo.py': 'def test_demo():\n    assert 1\n' })
  await install(withSuite)
  const config = readJson(path.join(withSuite, '.factory/build.json'))
  assert.equal(config.acceptance.name, 'acceptance')
  assert.match(config.acceptance.run, /acceptance\.py/)
  const settings = readJson(path.join(withSuite, '.claude/settings.json'))
  const stopTimeout = settings.hooks.Stop[0].hooks[0].timeout
  const budget = [...config.gates, config.acceptance, config.demo].reduce((sum: number, gate: { timeoutSeconds: number }) => sum + gate.timeoutSeconds, 0)
  assert.equal(stopTimeout, budget + 300)
})
