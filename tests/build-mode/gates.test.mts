import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const profile = path.resolve(import.meta.dirname, '../../build-mode/profiles/python-uv')

function project(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gates-')))
  fs.mkdirSync(path.join(dir, '.factory'))
  fs.copyFileSync(path.join(profile, 'build.json'), path.join(dir, '.factory/build.json'))
  fs.cpSync(path.join(profile, 'gates'), path.join(dir, '.factory/gates'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'))
  return dir
}

// A fake tool: a shell script that prints `stdout`, optionally writes files, and exits with `code`.
function fake(dir: string, name: string, stdout: string, code: number, writes: Record<string, string> = {}): string {
  const file = path.join(dir, `fake-${name}`)
  const lines = ['#!/bin/sh', `cat <<'OUT'\n${stdout}\nOUT`]
  for (const [target, content] of Object.entries(writes)) lines.push(`mkdir -p "$(dirname '${target}')"`, `cat > '${target}' <<'EDN'\n${content}\nEDN`)
  lines.push(`exit ${code}`)
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o755 })
  return file
}

function gate(dir: string, name: string, env: Record<string, string> = {}, args: string[] = []) {
  const result = spawnSync('python3', [path.join(dir, `.factory/gates/${name}.py`), ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  return { status: result.status, out: `${result.stdout}${result.stderr}` }
}

test('mutate fails closed when mutator reports survivors it cannot parse', () => {
  const dir = project()
  const tool = fake(dir, 'mutator', 'something survived, format changed', 3)
  const result = gate(dir, 'mutate', { LIGHTS_ON_TOOL_MUTATOR: tool })
  assert.equal(result.status, 1)
  assert.match(result.out, /FAIL: mutator reported survivors but none could be parsed/)
})

test('a full mutate run that analysed nothing fails; a --changed run with nothing to do passes', () => {
  const dir = project()
  const tool = fake(dir, 'mutator', 'Total 0 0 0 0', 0)
  const full = gate(dir, 'mutate', { LIGHTS_ON_TOOL_MUTATOR: tool })
  assert.equal(full.status, 1)
  assert.match(full.out, /FAIL: mutator ran no mutants under src/)
  assert.equal(gate(dir, 'mutate', { LIGHTS_ON_TOOL_MUTATOR: tool }, ['--changed']).status, 0)
})

test('a full mutate run clears earlier snapshots first', () => {
  const dir = project()
  fs.mkdirSync(path.join(dir, '.metrics/mutate'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.metrics/mutate/old.edn'), '{}')
  const tool = fake(dir, 'mutator', 'KILLED    src/a.py:1 + -> -', 0)
  assert.equal(gate(dir, 'mutate', { LIGHTS_ON_TOOL_MUTATOR: tool }).status, 0)
  assert.ok(!fs.existsSync(path.join(dir, '.metrics/mutate/old.edn')))
})

test('crap fails when crapper scored no functions', () => {
  const dir = project()
  const tool = fake(dir, 'crapper', 'CRAP Report', 0, { '.metrics/crap.edn': '{:entries []}' })
  const result = gate(dir, 'crap', { LIGHTS_ON_TOOL_CRAPPER: tool })
  assert.equal(result.status, 1)
  assert.match(result.out, /FAIL: crapper scored no functions under src/)
})

test('dry ignores a stale report and fails when dryer writes none', () => {
  const dir = project()
  fs.mkdirSync(path.join(dir, '.metrics'))
  fs.writeFileSync(path.join(dir, '.metrics/dry.edn'), '{:candidates [{:score 0.95}]}')
  const clean = fake(dir, 'dryer', 'no duplicates', 0, { '.metrics/dry.edn': '{:candidates []}' })
  assert.equal(gate(dir, 'dry', { LIGHTS_ON_TOOL_DRYER: clean }).status, 0)
  fs.writeFileSync(path.join(dir, '.metrics/dry.edn'), '{:candidates []}')
  const silent = fake(dir, 'dryer-silent', 'nothing', 0)
  const result = gate(dir, 'dry', { LIGHTS_ON_TOOL_DRYER: silent })
  assert.equal(result.status, 1)
  assert.match(result.out, /FAIL: dryer wrote no report/)
})

test('tests refuses configuration that deselects or drops tests', () => {
  for (const [file, content] of [
    ['conftest.py', 'collect_ignore = ["tests/test_hard.py"]\n'],
    ['tests/conftest.py', 'def pytest_collection_modifyitems(items):\n    items.clear()\n'],
    ['pyproject.toml', '[tool.pytest.ini_options]\naddopts = "--deselect tests/test_a.py::test_x"\n'],
  ]) {
    const dir = project()
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
    const result = gate(dir, 'tests')
    assert.equal(result.status, 1, file)
    assert.match(result.out, new RegExp(`FAIL: ${file.replace('.', '\\.')} configures pytest to drop tests`))
  }
})

test('lint and types ignore project config the agent could loosen', () => {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'build.json'), 'utf8')) as { gates: { name: string; run: string }[] }
  const run = (name: string) => config.gates.find(g => g.name === name)?.run ?? ''
  assert.match(run('lint'), /ruff check --isolated src tests/)
  assert.match(run('lint'), /ruff format --isolated --check src tests/)
  assert.match(run('types'), /mypy --strict --config-file \.factory\/gates\/mypy\.ini src/)
  assert.ok(fs.existsSync(path.join(profile, 'gates/mypy.ini')))
})
