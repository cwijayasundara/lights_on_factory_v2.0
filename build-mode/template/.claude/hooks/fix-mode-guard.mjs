#!/usr/bin/env node
// PreToolUse hook: while a `.fix-mode` file exists at the project root, existing tests/evals cannot be edited.
// New test files are still allowed, so the flow is: write a failing test, then fix the code without touching it.
import fs from 'node:fs'
import path from 'node:path'

let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
} catch {}
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd()
const file = input.tool_input?.file_path
if (!file || !fs.existsSync(path.join(root, '.fix-mode'))) process.exit(0)
const abs = path.resolve(root, file)
const rel = path.relative(root, abs).split(path.sep).join('/')
if ((rel.startsWith('tests/') || rel.startsWith('evals/')) && fs.existsSync(abs)) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `fix mode: ${rel} is an existing test; change the code to pass it, or add a new test file. Delete .fix-mode when the fix is done`,
      },
    })}\n`,
  )
}
