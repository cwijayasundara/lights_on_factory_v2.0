import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error plain ESM hook module without types
import { applyEvent, fromTranscript } from '../../build-mode/template/.claude/hooks/lib/runs.mjs'

const T0 = Date.parse('2026-11-01T10:00:00Z')
const at = (seconds: number) => new Date(T0 + seconds * 1000)

const line = (value: unknown) => JSON.stringify(value)
const assistant = (id: string, model: string, usage: Record<string, number>) => line({ type: 'assistant', message: { id, model, usage } })

test('tokens are summed per distinct message id, the last usage for an id wins', () => {
  const text = [
    assistant('m1', 'claude-a', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    assistant('m1', 'claude-a', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }),
    assistant('m2', 'claude-b', { input_tokens: 20, output_tokens: 3 }),
    line({ type: 'user', message: { content: 'hi' } }),
    'not json',
  ].join('\n')
  assert.deepEqual(fromTranscript(text), {
    model: 'claude-b',
    tokens: { input: 30, output: 10, cacheRead: 100, cacheCreation: 5 },
  })
})

test('a transcript with no usage gives null, not zero', () => {
  assert.deepEqual(fromTranscript(line({ type: 'user', message: { content: 'hi' } })), { model: null, tokens: null })
  assert.deepEqual(fromTranscript(undefined), { model: null, tokens: null })
})

test('the first event creates a record with nulls for what is unknown', () => {
  const record = applyEvent(null, { kind: 'session-start', sessionId: 's1', phase: 'build', now: at(0) })
  assert.equal(record.version, 1)
  assert.equal(record.sessionId, 's1')
  assert.equal(record.startedAt, '2026-11-01T10:00:00.000Z')
  assert.equal(record.model, null)
  assert.equal(record.tier, null)
  assert.equal(record.tokens, null)
  assert.equal(record.tasksDone, null)
  assert.equal(record.outcome, null)
  assert.equal(record.endedAt, null)
})

test('stop events accumulate stops, blocks, per-gate runs, failures and seconds', () => {
  let record = applyEvent(null, { kind: 'session-start', sessionId: 's1', phase: 'build', now: at(0) })
  record = applyEvent(record, {
    kind: 'stop', phase: 'build', now: at(60), decision: 'block',
    gates: [{ name: 'tests', ok: true, seconds: 2.5 }, { name: 'lint', ok: false, seconds: 1 }],
    tasks: { done: 3, total: 11 },
  })
  record = applyEvent(record, {
    kind: 'stop', phase: 'build', now: at(120), decision: 'block',
    gates: [{ name: 'tests', ok: true, seconds: 3 }, { name: 'lint', ok: true, seconds: 1 }],
    tasks: { done: 5, total: 11 },
  })
  assert.equal(record.stops, 2)
  assert.equal(record.blocks, 2)
  assert.equal(record.wallSeconds, 120)
  assert.deepEqual(record.gates.tests, { runs: 2, failures: 0, seconds: 5.5 })
  assert.deepEqual(record.gates.lint, { runs: 2, failures: 1, seconds: 2 })
  assert.equal(record.tasksDone, 5)
  assert.equal(record.tasksTotal, 11)
  assert.equal(record.outcome, null)
})

test('an allow sets the outcome and end time; later events in the same session do not erase them', () => {
  let record = applyEvent(null, { kind: 'session-start', sessionId: 's1', phase: 'build', now: at(0) })
  record = applyEvent(record, { kind: 'stop', phase: 'build', now: at(300), decision: 'allow', header: 'COMPLETE', gates: [], tasks: { done: 2, total: 2 } })
  assert.equal(record.outcome, 'COMPLETE')
  assert.equal(record.endedAt, '2026-11-01T10:05:00.000Z')
  assert.equal(record.allows, 1)
  record = applyEvent(record, { kind: 'session-start', sessionId: 's1', phase: 'maintain', now: at(400) })
  assert.equal(record.outcome, 'COMPLETE')
  assert.equal(record.startedAt, '2026-11-01T10:00:00.000Z')
})

test('model and tokens from the transcript are recorded when known and kept when later unknown', () => {
  let record = applyEvent(null, { kind: 'session-start', sessionId: 's1', phase: 'build', now: at(0) })
  record = applyEvent(record, {
    kind: 'stop', phase: 'build', now: at(10), decision: 'block', gates: [],
    transcript: { model: 'claude-x', tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } },
  })
  record = applyEvent(record, { kind: 'stop', phase: 'build', now: at(20), decision: 'block', gates: [], transcript: { model: null, tokens: null } })
  assert.equal(record.model, 'claude-x')
  assert.deepEqual(record.tokens, { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
})
