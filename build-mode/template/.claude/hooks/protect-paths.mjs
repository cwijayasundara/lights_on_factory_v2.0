#!/usr/bin/env node
// Build-mode PreToolUse hook: deny file edits inside the paths .factory/build.json protects.
// Edits made through Bash are caught later by the Stop hook's protected-diff check.
import fs from 'node:fs'
import path from 'node:path'

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

function findRoot(start) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, '.factory/build.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

// The hook owns the phase; the agent may not flip it, whatever build.json lists.
const ALWAYS = ['.factory/phase']

function isProtected(relative, entries) {
  return entries.some(entry => (entry.endsWith('/') ? `${relative}/`.startsWith(entry) : relative === entry))
}

function main() {
  const input = readInput()
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const root = findRoot(cwd)
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path
  if (!root || !file) return
  const config = JSON.parse(fs.readFileSync(path.join(root, '.factory/build.json'), 'utf8'))
  const relative = path.relative(root, path.resolve(cwd, file)).split(path.sep).join('/')
  if (relative.startsWith('..') || !isProtected(relative, [...ALWAYS, ...(config.protected ?? [])])) return
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${relative} is protected by build mode; record the need in BLOCKED.md instead`,
    },
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`protect-paths: ${error.message}\n`)
}
