#!/usr/bin/env node
// PostToolUse hook: after a Python edit, run ruff and report problems back to the agent. Scoped to the changed file.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
} catch {}
const file = input.tool_input?.file_path
if (!file || !file.endsWith('.py')) process.exit(0)
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
const run = args => spawnSync('uv', ['run', 'ruff', ...args, '--isolated', file], { cwd: root, encoding: 'utf8' })
const problems = [run(['check']), run(['format', '--check'])].filter(r => r.status !== 0).map(r => r.stdout + r.stderr)
if (problems.length) {
  process.stderr.write(`ruff found problems in ${file}; fix them (ruff format fixes layout):\n${problems.join('\n')}`)
  process.exit(2)
}
