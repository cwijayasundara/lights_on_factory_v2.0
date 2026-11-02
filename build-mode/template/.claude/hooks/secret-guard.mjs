#!/usr/bin/env node
// PreToolUse hook: deny edits whose new text contains something that looks like a credential.
import fs from 'node:fs'

const SECRET =
  /(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"])/i

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  } catch {
    return {}
  }
}

const input = readInput()
const ti = input.tool_input ?? {}
const text = [ti.content, ti.new_string, ...(ti.edits ?? []).map(e => e.new_string)].filter(Boolean).join('\n')
const match = SECRET.exec(text)
if (match) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `edit contains what looks like a credential ('${match[0].slice(0, 8)}...'); read it from the environment instead`,
      },
    })}\n`,
  )
}
