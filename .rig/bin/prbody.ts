// The PR body (proposal 2026-10-25 A1): what a reviewer needs before reading the diff. Built from the change's own files, no model
// call; the pr skill adds the part that takes judgement (special things to note, the change outline) as pr-outline.md.
import { section, blastRadius, bullets } from './model.ts'
import type { Risk } from './risk.ts'
import type { RunRow } from './runs.ts'
import { behaviourIds, missingBehaviours } from './sensors.ts'

type PrBodyInput = { intent: string; spec: string; plan: string; verify: { pass: boolean; tree: string | null; blocks: string[]; from?: string } | null; outline: string; review: string; risk: Risk; amendments?: string; runs?: RunRow[]; tests?: string }

const firstSentence = (text: string): string => /^[\s\S]*?[.!?](?=\s|$)/.exec(text.trim())?.[0].replace(/\s+/g, ' ') ?? text.trim().replace(/\s+/g, ' ')

// One-way when the plan edits a contract file (they freeze at approval), else two-way: reverting the merge undoes it.
const contracts = (plan: string): string[] => bullets(section(plan, 'Contracts')).map(l => l.replace(/^[-*]\s+/, '').replace(/`/g, ''))

function door(plan: string): string {
  const c = contracts(plan)
  return c.length ? `one-way (contracts: ${c.join(', ')})` : 'two-way'
}

function revert(plan: string): string {
  const c = contracts(plan)
  return c.length
    ? `Reverting the code does not undo the contract change to ${c.join(', ')}: ship the previous contract as a new change (expand–migrate–contract).`
    : 'Revert the change: `git revert <sha>` for a plain commit on the trunk, or `git revert -m 1 <merge sha>` for a merge commit.'
}

// Evidence, not claims (proposal 2026-10-29 item 2): what the latest verify's recorded runs show (evidence/runs.jsonl), never the model.
const plain = (l: string): string => l.replace(/\x1b\[[0-9;]*m/g, '').trim()
const FAIL_LINE = /\bFAIL(ED)?\b|\bError\b|error:|error\[|✖|not ok|assert|Interrupted|panicked/i
// A red that is only a missing import, a missing symbol or a collection error shows the tests need new code, not which
// behaviour fails without it. A file that fails to load prints ✖ / not ok too, so those never count as an assertion.
const COLLECTION = /error during collection|ModuleNotFoundError|ImportError|Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named|Failed to load url|has no exported member|Test suite failed to run|cannot find symbol|cannot find (function|value|type|package)|undefined: \w|unresolved import|could not compile|\[build failed\]|error CS0103|error CS0246|does not exist in the current context/i
const ASSERTION = /AssertionError|\bassert(ion)?\b|expected:|Expected:|toBe|toEqual|but was|--- FAIL/
// A fence longer than any backtick run in the text, so a test's output never closes it.
const fenced = (lines: string[]): string => { const f = '`'.repeat(Math.max(3, ...lines.map(l => Math.max(0, ...(l.match(/`+/g) ?? []).map(m => m.length + 1))))); return `${f}\n${lines.join('\n')}\n${f}` }
const span = (t: string): string => `\`${t.replace(/`/g, "'")}\``

function baseProof(runs: RunRow[]): string {
  const red = runs.findLast(r => r.expectFail && r.source === 'ship')
  const green = runs.filter(r => r.sensor === 'red-proof' && r.cwd && !r.expectFail).at(-1)
  if (!red) return green ? `Green proof (refactor): the change's tests ran on the base code and ${green.exit === 0 ? 'passed' : `failed (exit ${green.exit})`}, ${span(green.cmd)}.` : 'Red proof: no run of the new tests on the base code is recorded.'
  const tail = red.tail.split('\n').map(plain).filter(Boolean)
  if (red.exit === 0) return `Red proof: none. The new tests passed on the base code (${span(red.cmd)}), and verify passed only because red-proof was waived.`
  const hits = tail.filter(l => FAIL_LINE.test(l)).slice(-6)
  const weak = COLLECTION.test(red.tail) && !ASSERTION.test(red.tail)
    ? '\n\nWeak red: the tests failed on a missing import, a missing symbol or a collection error, not an assertion. It shows they need the new code, not which behaviour fails without it.' : ''
  return `Red proof: the change's tests ran on the base code and failed (exit ${red.exit}, ${span(red.cmd)}):\n\n${fenced((hits.length ? hits : tail.slice(-3)).map(l => l.slice(0, 200)))}${weak}`
}

// The latest run of each check on the head tree (a base-tree run has a cwd), in the order they first ran.
function headChecks(runs: RunRow[]): string {
  const last = new Map<string, RunRow>()
  for (const r of runs) if (r.source === 'ship' && !r.cwd && !r.expectFail) last.set(r.sensor ?? r.cmd, r)
  if (!last.size) return ''
  const line = (name: string, r: RunRow): string => { const end = (r.tail.split('\n').map(plain).filter(Boolean).at(-1) ?? '').slice(0, 120); return `- ${name.length > 60 ? `${name.slice(0, 57)}...` : name}: ${r.exit === 0 ? 'pass' : `fail (exit ${r.exit})`}${end ? `, ${span(end)}` : ''}` }
  return `Checks on the head tree (the latest verify's run of each):\n\n${[...last].map(([n, r]) => line(n, r)).join('\n')}`
}

// The behaviours no test the change adds or edits names, by the traceability sensor's own rule.
function behaviourTests(spec: string, tests: string | undefined): string {
  const ids = behaviourIds(spec, 'Behaviours')
  if (!ids.length || tests === undefined) return ''
  const none = missingBehaviours(ids, tests)
  return none.length ? `No test this change adds or edits names ${none.join(', ')}: check those behaviours by hand.` : `Every behaviour (${ids.join(', ')}) is named by a test this change adds or edits.`
}

export function prBody(i: PrBodyInput): string {
  const why = firstSentence(section(i.intent, 'Intent')) || 'none recorded'
  const behaviours = bullets(section(i.spec, 'Behaviours'))
  const radius = (blastRadius(i.spec) ?? []).map(p => `- ${p}`)
  const amended = bullets(section(i.amendments ?? '', 'Amendments')).filter(l => !/^[-*]\s+none\.?$/i.test(l))
  const evidence = i.verify ? `verify: ${i.verify.pass ? 'pass' : 'fail'} on tree ${i.verify.tree ?? 'unknown'} (${i.verify.blocks.join(', ') || 'no blocking sensors'})` : 'verify: none'
  const missed = bullets(section(i.review, 'Unverifiable'))
  // Only the latest verify's runs: an older run of a check it did not re-run is not evidence about this tree.
  const from = i.verify?.from, runs = (i.runs ?? []).filter(r => !from || r.at >= from)
  const parts = [
    `## Why the change\n\n${why}`,
    behaviours.length ? `## Behaviours\n\n${behaviours.join('\n')}` : '',
    amended.length ? `## Amendments after approval\n\n${amended.join('\n')}` : '',
    `## Blast radius\n\n${radius.length ? radius.join('\n') : 'none recorded'}\n\nDoor: ${door(i.plan)}`,
    `## Risk\n\n${i.risk.reasons.length ? `Tier ${i.risk.tier}\n\n${i.risk.reasons.map(r => `- ${r}`).join('\n')}` : 'Tier 0: none of the signals'}`,
    `## How to revert\n\n${revert(i.plan)}`,
    `## What the checks would miss\n\n${!i.review.trim() ? 'no review.md' : missed.length ? missed.join('\n') : 'nothing the reviewer named'}`,
    `## Evidence\n\n${[evidence, baseProof(runs), headChecks(runs), behaviourTests(i.spec, i.tests)].filter(Boolean).join('\n\n')}`,
    i.outline.trim(),
  ]
  return parts.filter(Boolean).join('\n\n') + '\n'
}
