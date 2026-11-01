// Run records: one JSON file per Claude Code session in .factory/runs/, updated at every hook event.
// Measures what the harness costs and does. Anything Claude Code does not expose is null, never an estimate.
import fs from 'node:fs'
import path from 'node:path'

const RUNS = '.factory/runs'
const round = value => Math.round(value * 1000) / 1000

// Model and token totals from a session transcript (JSONL). Streaming repeats a message id with growing
// usage, so the last usage per id counts. Subagent work lives in other transcripts and is not included.
export function fromTranscript(text) {
  const usage = new Map()
  let model = null
  for (const row of (text ?? '').split('\n')) {
    let entry
    try {
      entry = JSON.parse(row)
    } catch {
      continue
    }
    const message = entry?.type === 'assistant' ? entry.message : null
    if (!message?.usage || !message.id) continue
    usage.set(message.id, message.usage)
    model = message.model ?? model
  }
  if (usage.size === 0) return { model: null, tokens: null }
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  for (const each of usage.values()) {
    tokens.input += each.input_tokens ?? 0
    tokens.output += each.output_tokens ?? 0
    tokens.cacheRead += each.cache_read_input_tokens ?? 0
    tokens.cacheCreation += each.cache_creation_input_tokens ?? 0
  }
  return { model, tokens }
}

// Pure: fold one hook event into the session's record.
export function applyEvent(existing, event) {
  const record = existing ?? {
    version: 1,
    sessionId: event.sessionId ?? null,
    startedAt: event.now.toISOString(),
    endedAt: null,
    outcome: null,
    phase: event.phase,
    model: null,
    tier: null,
    tasksDone: null,
    tasksTotal: null,
    wallSeconds: 0,
    stops: 0,
    blocks: 0,
    allows: 0,
    gates: {},
    tokens: null,
  }
  record.phase = event.phase
  record.wallSeconds = round((event.now.getTime() - Date.parse(record.startedAt)) / 1000)
  if (event.kind !== 'stop') return record

  record.stops += 1
  if (event.decision === 'block') record.blocks += 1
  else {
    record.allows += 1
    record.outcome = event.header ?? record.outcome
    record.endedAt = event.now.toISOString()
  }
  for (const gate of event.gates ?? []) {
    const each = (record.gates[gate.name] ??= { runs: 0, failures: 0, seconds: 0 })
    each.runs += 1
    if (!gate.ok) each.failures += 1
    each.seconds = round(each.seconds + (gate.seconds ?? 0))
  }
  if (event.tasks) {
    record.tasksDone = event.tasks.done
    record.tasksTotal = event.tasks.total
  }
  record.model = event.transcript?.model ?? record.model
  record.tokens = event.transcript?.tokens ?? record.tokens
  return record
}

function fileFor(root, sessionId) {
  const directory = path.join(root, RUNS)
  const short = (sessionId ?? 'nosession').slice(0, 8)
  const found = fs.existsSync(directory) ? fs.readdirSync(directory).find(name => name.endsWith(`-${short}.json`)) : null
  return { directory, file: found ? path.join(directory, found) : null, short }
}

// Never throws: a failed measurement must not change a Stop decision.
export function recordEvent(root, event) {
  try {
    const { directory, file, short } = fileFor(root, event.sessionId)
    const existing = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    const record = applyEvent(existing, event)
    const target = file ?? path.join(directory, `${record.startedAt.replace(/[:.]/g, '-')}-${short}.json`)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`)
  } catch {
    // measurement only
  }
}
