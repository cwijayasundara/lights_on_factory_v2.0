import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

async function installCloudProfile(options: { rigRepo: string; target: string; factoryRoot: string }): Promise<void> {
  const loaded = await import('../../scripts/install-cloud-profile.ts') as {
    installCloudProfile: (options: { rigRepo: string; target: string; factoryRoot: string }) => void
  }
  loaded.installCloudProfile(options)
}

const repoRoot = path.resolve(import.meta.dirname, '../..')
const pinCommit = 'f33015bf12e711be7441eca45fefb177fd5d81cc'
const rigRepo = process.env.RIG_REPO ?? path.resolve(repoRoot, '../../learning_101/rig_v1')
const expectedSkills = ['rig-chart', 'rig-plan', 'rig-build', 'rig-pr']

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {}) {
  return spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: options.env, input: options.input })
}

async function installInto(target: string) {
  await installCloudProfile({ rigRepo, target, factoryRoot: repoRoot })
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

test('compatibility note records the pin, the path strategy, and that native cloud was not observed', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'docs/cloud-compatibility.md'), 'utf8')
  assert.match(text, new RegExp(pinCommit))
  assert.match(text, /\$CLAUDE_PROJECT_DIR\/\.rig\/bin\/sdlc\.ts/)
  assert.match(text, /native cloud session was not observed/i)
  assert.match(text, /enabledPlugins/)
  assert.match(text, /CLAUDE_PLUGIN_ROOT/)
})

test('environment setup fails visibly when Node is missing or older than 22.18', () => {
  const script = path.join(repoRoot, 'cloud/environment-setup.sh')
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'old-node-'))
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

test('a fresh install resolves hooks and skills without the plugin root', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-profile-'))
  run('git', ['init'], { cwd: target })
  await installInto(target)
  await installInto(target)
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
  const vendoredRisk = fs.readFileSync(path.join(target, '.rig/bin/risk.ts'), 'utf8')
  const pinnedRisk = run('git', ['-C', rigRepo, 'show', `${pinCommit}:scripts/risk.ts`])
  assert.equal(pinnedRisk.status, 0)
  assert.equal(vendoredRisk, pinnedRisk.stdout)
  const session = commands.find(command => command.includes('hook session-start'))
  assert.ok(session)
  const once = run('bash', ['-lc', expand(session, target)], {
    cwd: target,
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: '{}',
  })
  const twice = run('bash', ['-lc', expand(session, target)], {
    cwd: target,
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: '{}',
  })
  assert.equal(once.status, 0, once.stderr)
  assert.equal(twice.status, 0, twice.stderr)
})

test('a missing checker and a forbidden edit both fail visibly', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-profile-'))
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
  fs.writeFileSync(secretFile, 'key=AKIAIOSFODNN7EXAMPLE\n')
  const forbidden = run('bash', ['-lc', expand(postEdit, target)], {
    cwd: target,
    env: { ...process.env, CLAUDE_PROJECT_DIR: target },
    input: JSON.stringify({ tool_input: { file_path: secretFile } }),
  })
  assert.equal(forbidden.status, 2)
  assert.match(forbidden.stderr, /sdlc check failed/)
})
