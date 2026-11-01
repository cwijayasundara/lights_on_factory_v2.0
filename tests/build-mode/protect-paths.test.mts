import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const hook = path.resolve(import.meta.dirname, '../../build-mode/template/.claude/hooks/protect-paths.mjs')

function target(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protect-')))
  fs.mkdirSync(path.join(dir, '.factory'))
  fs.writeFileSync(
    path.join(dir, '.factory/build.json'),
    JSON.stringify({ protected: ['.claude/', '.factory/build.json', '.factory/gates/', 'SPEC.md'] }),
  )
  return dir
}

function check(dir: string, tool: string, input: Record<string, string>) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: dir, tool_name: tool, tool_input: input }),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null
}

function denied(dir: string, tool: string, input: Record<string, string>, shown: string) {
  const out = check(dir, tool, input)
  assert.equal(out?.hookEventName, 'PreToolUse')
  assert.equal(out?.permissionDecision, 'deny')
  assert.equal(out?.permissionDecisionReason, `${shown} is protected by build mode; record the need in BLOCKED.md instead`)
}

test('denies Write to .claude/settings.json', () => {
  const dir = target()
  denied(dir, 'Write', { file_path: path.join(dir, '.claude/settings.json') }, '.claude/settings.json')
})

test('denies Edit to SPEC.md via an absolute path', () => {
  const dir = target()
  denied(dir, 'Edit', { file_path: path.join(dir, 'SPEC.md') }, 'SPEC.md')
})

test('denies .factory/gates/tests.py and .factory/build.json', () => {
  const dir = target()
  denied(dir, 'Write', { file_path: path.join(dir, '.factory/gates/tests.py') }, '.factory/gates/tests.py')
  denied(dir, 'MultiEdit', { file_path: path.join(dir, '.factory/build.json') }, '.factory/build.json')
})

test('allows src/app.py and .factory/accepted-mutants.md', () => {
  const dir = target()
  assert.equal(check(dir, 'Write', { file_path: path.join(dir, 'src/app.py') }), null)
  assert.equal(check(dir, 'Edit', { file_path: path.join(dir, '.factory/accepted-mutants.md') }), null)
  assert.equal(check(dir, 'Write', { file_path: path.join(dir, 'SPEC.md.bak') }), null)
})

test('denies ../ traversal that resolves into .claude/', () => {
  const dir = target()
  denied(dir, 'Write', { file_path: path.join(dir, 'src/../.claude/hooks/build-gate.mjs') }, '.claude/hooks/build-gate.mjs')
})

test('denies a relative path and a notebook path', () => {
  const dir = target()
  denied(dir, 'Write', { file_path: 'SPEC.md' }, 'SPEC.md')
  denied(dir, 'NotebookEdit', { notebook_path: path.join(dir, '.claude/x.ipynb') }, '.claude/x.ipynb')
})

test('allows everything outside a build-mode target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'))
  assert.equal(check(dir, 'Write', { file_path: path.join(dir, 'SPEC.md') }), null)
})
