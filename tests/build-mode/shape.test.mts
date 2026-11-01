import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const factoryRoot = path.resolve(import.meta.dirname, '../..')
const script = path.join(factoryRoot, 'scripts/start-shape.ts')

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function repo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shape-')))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'notes.md'), 'idea\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

function fakeClaude(): { env: NodeJS.ProcessEnv; log: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'))
  const log = path.join(home, 'calls.jsonl')
  const bin = path.join(home, 'claude')
  fs.writeFileSync(bin, `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify([process.cwd(), ...process.argv.slice(2)]) + "\\n")' "${log}" "$@"\n`, { mode: 0o755 })
  return { env: { ...process.env, LIGHTS_ON_CLAUDE: bin }, log }
}

test('start-shape adds the shape skill in its own commit and opens an interactive session on it', () => {
  const dir = repo()
  fs.writeFileSync(path.join(dir, 'wip.txt'), 'unrelated work in progress\n')
  const fake = fakeClaude()
  const result = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: fake.env })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(fs.existsSync(path.join(dir, '.claude/skills/shape/SKILL.md')))
  assert.equal(git(dir, 'log', '-1', '--format=%s'), 'chore: add shape skill')
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), '.claude/skills/shape/SKILL.md')
  assert.match(git(dir, 'status', '--porcelain'), /wip\.txt/)
  const [call] = fs.readFileSync(fake.log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(fs.realpathSync(call[0]), dir)
  assert.equal(call.length, 2, 'interactive: one prompt argument, no -p')
  assert.match(call[1], /shape skill/)
})

test('start-shape is idempotent and refuses a non-repository and the factory itself', () => {
  const dir = repo()
  const fake = fakeClaude()
  spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: fake.env })
  const head = git(dir, 'rev-parse', 'HEAD')
  const again = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: fake.env })
  assert.equal(again.status, 0)
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head)

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'))
  assert.equal(spawnSync(process.execPath, [script, plain], { encoding: 'utf8', env: fake.env }).status, 1)
  const self = spawnSync(process.execPath, [script, factoryRoot], { encoding: 'utf8', env: fake.env })
  assert.equal(self.status, 1)
  assert.match(self.stderr, /factory repository itself/)
})
