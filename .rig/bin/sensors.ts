// Language-agnostic sensors: pure functions from a parsed diff and config to findings.
// Language knowledge lives in the pattern tables below, never in code paths per language.
import { parseRules, section, type FileDiff, type Finding, type Layer, isTest, isSource, matchesAny, escapeRe, globToRegex, SECRET_PATTERNS } from './model.ts'
import { weakensRegistry, parseRegistry, builtinOptions, type Registry } from './registry.ts'
import { RATCHET_FILE, weakensRatchets } from './counts.ts'
import { SENSORS_JSON, skillRef } from './core.ts'

export const TAMPER_PATTERNS: { id: string; re: RegExp; what: string }[] = [
  { id: 'skip-or-only', re: /\b(?:it|describe|test|context|suite)\.(?:skip|only|todo)\s*[.(]/, what: 'test skipped or focused' },
  { id: 'x-prefixed', re: /^\s*x(?:it|describe|test|context)\s*\(/, what: 'test disabled with an x prefix' },
  { id: 'jasmine-focus', re: /^\s*f(?:it|describe|context)\s*\(/, what: 'test focused with an f prefix' },
  { id: 'pytest-skip', re: /^\s*@pytest\.mark\.(?:skip|skipif|xfail)\b/, what: 'pytest skip/xfail marker' },
  { id: 'unittest-skip', re: /^\s*@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/, what: 'unittest skip decorator' },
  { id: 'junit-disabled', re: /^\s*@(?:Disabled|Ignore)\b(?!\w)/, what: 'JUnit @Disabled/@Ignore' },
  { id: 'go-skip', re: /\bt\.Skip(?:Now|f)?\(/, what: 'Go t.Skip' },
  { id: 'rspec-pending', re: /^\s*(?:pending|skip)\b(?:\s+["']|\s*$|\s+do\b)/, what: 'RSpec pending/skip' },
]

export const SUPPRESSIONS: RegExp[] = [
  /eslint-disable/, /@ts-(?:ignore|expect-error|nocheck)\b/, /#\s*type:\s*ignore/, /#\s*noqa\b/, /pylint:\s*disable/, // -- the detector's own patterns
  /\/\/\s*nolint\b/, /@SuppressWarnings\b/, /rubocop:disable/, /#\s*pragma:\s*no\s*cover/, /istanbul\s+ignore/, /\bnosemgrep\b/, // -- the detector's own patterns
]

const REASONED = /(?:\s--\s*|\bbecause\b\s*)\S/i
const COMMENT_LINE = /^\s*(?:\/\/|#|\*|\/\*|--|;)/
const ASSERTION = /\bassert(?:\.\w+\s*\(|\w*\s*[!(])|^\s*assert\s|\bexpect\s*[({]|\.should\b|\bAssert\.\w+\s*\(|\bt\.(?:Error|Fatal)f?\s*\(|\brequire\.\w+\s*\(/g
const THRESHOLD_KEY = /coverage|threshold|fail[_-]under|minimum|\b(?:lines|branches|functions|statements)\b/i
const CONFIG_FILE = /(?:^|\/)(?:[^/]*\.(?:json|ya?ml|toml|cfg|ini|xml|gradle|kts|properties)|\.[\w-]*rc(?:\.\w+)?|[^/]*\.config\.[cm]?[jt]s)$/
const SNAPSHOT = /(?:^|\/)__snapshots__\/|\.snap$/
const KEEP_TESTS = `keep the test and make the code pass it; removing a test needs the person's ${skillRef('waive')}`

const countAssertions = (texts: string[]): number =>
  texts.filter(t => !COMMENT_LINE.test(t)).reduce((n, t) => n + (t.match(ASSERTION)?.length ?? 0), 0)

function similarity(gone: Set<string>, candidate: FileDiff): number {
  if (!gone.size) return 1
  const have = new Set(candidate.added.map(l => l.text.trim()))
  let hit = 0
  for (const line of gone) if (have.has(line)) hit++
  return hit / gone.size
}

function loweredThresholds(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  const key = (t: string): string => t.replace(/\d+(?:\.\d+)?/g, '#').trim()
  const num = (t: string): number => Number(/\d+(?:\.\d+)?/.exec(t)?.[0])
  for (const d of diffs.filter(f => CONFIG_FILE.test(f.file) && !f.binary)) {
    const before = new Map(d.removed.filter(l => THRESHOLD_KEY.test(l.text) && /\d/.test(l.text)).map(l => [key(l.text), num(l.text)]))
    for (const l of d.added) {
      const was = before.get(key(l.text))
      if (was !== undefined && THRESHOLD_KEY.test(l.text) && num(l.text) < was) {
        findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `threshold lowered from ${was} to ${num(l.text)}`, fix: 'restore the threshold and add the missing tests instead' })
      }
    }
  }
  return findings
}

// Files that intentionally contain detector patterns (a human-approved list) are invisible to the pattern sensors only.
// Deletions stay visible, so removing a fixture or test file is still reported.
export const withoutFixtures = (diffs: FileDiff[], r: Registry): FileDiff[] => (r.paths.fixtures.length ? diffs.filter(d => d.status === 'D' || !matchesAny(d.file, r.paths.fixtures)) : diffs)

export function testTamper(diffs: FileDiff[], r: Registry): Finding[] {
  const findings: Finding[] = []
  const tests = diffs.filter(d => isTest(d.file, r.paths) && !d.binary)
  const newFiles = tests.filter(d => d.status === 'A')
  const reported = new Set<string>()
  for (const d of tests.filter(t => t.status === 'D')) {
    const gone = new Set(d.removed.map(l => l.text.trim()).filter(Boolean))
    if (!newFiles.some(n => similarity(gone, n) >= 0.6)) {
      reported.add(d.file)
      findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, message: 'test file deleted', fix: KEEP_TESTS })
    }
  }
  for (const d of tests) {
    for (const l of d.added.filter(a => !COMMENT_LINE.test(a.text))) {
      const hit = TAMPER_PATTERNS.find(p => p.re.test(l.text))
      if (hit) findings.push({ sensor: 'test-tamper', severity: 'block', file: d.file, line: l.n, message: `${hit.what}: ${l.text.trim()}`, fix: KEEP_TESTS })
    }
  }
  const removed = countAssertions(tests.filter(d => !reported.has(d.file)).flatMap(d => d.removed.map(l => l.text)))
  const added = countAssertions(tests.flatMap(d => d.added.map(l => l.text)))
  if (removed > added) {
    findings.push({ sensor: 'test-tamper', severity: 'block', message: `assertions dropped across the test diff: ${removed} removed, ${added} added`, fix: 'keep every assertion that still applies; a weaker test hides bugs' })
  }
  findings.push(...loweredThresholds(diffs))
  for (const d of diffs) {
    if (SNAPSHOT.test(d.file) && d.status === 'M') findings.push({ sensor: 'test-tamper', severity: 'warn', file: d.file, message: 'snapshot rewritten', fix: 'check the snapshot change is intended' })
  }
  return findings
}

export function suppressions(diffs: FileDiff[], r: Registry): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary && !f.file.startsWith('.rig/') && (isSource(f.file, r.paths) || isTest(f.file, r.paths)))) {
    for (const l of d.added) {
      if (SUPPRESSIONS.some(re => re.test(l.text)) && !REASONED.test(l.text)) {
        findings.push({ sensor: 'suppression', severity: 'block', file: d.file, line: l.n, message: `suppression added: ${l.text.trim()}`, fix: 'fix the warning instead, or give the reason on the same line after "--" or "because"' })
      }
    }
  }
  return findings
}

const IMPORT_LINE = /^\s*(?:import|from|require|use|using|#\s*include|include|extern\s+crate)\b|\brequire\s*\(|\bimport\s*\(/
const word = (t: string): RegExp => new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRe(t)}(?:$|[^A-Za-z0-9_])`)

export function layering(diffs: FileDiff[], r: Registry): Finding[] {
  const findings: Finding[] = []
  for (const layer of (builtinOptions(r, 'layering').layers ?? []) as Layer[]) {
    const from = globToRegex(layer.from)
    const banned = layer.mustNotImport.map(t => ({ t, re: word(t) }))
    for (const d of diffs.filter(f => from.test(f.file) && !f.binary)) {
      for (const l of d.added.filter(a => IMPORT_LINE.test(a.text) && !/^\s*(?:\/\/|#(?!\s*include))/.test(a.text))) {
        const hit = banned.find(b => b.re.test(l.text))
        if (hit) findings.push({ sensor: 'layering', severity: 'block', file: d.file, line: l.n, message: `${layer.from} must not import ${hit.t}: ${layer.why}`, fix: `depend on an interface owned by this layer and inject the ${hit.t} implementation at the boundary${layer.example ? ` (example: ${layer.example})` : ''}` })
      }
    }
  }
  return findings
}

export function size(diffs: FileDiff[], r: Registry, fileLines: Record<string, number>, point: 'edit' | 'stop' | 'ship' | 'ci'): Finding[] {
  const o = builtinOptions(r, 'size')
  const limits = { fileLines: Number(o.fileLines ?? 400), diffLines: Number(o.diffLines ?? 500), lineChars: Number(o.lineChars ?? 160) }
  const findings: Finding[] = diffs.filter(d => d.oversize).map(d => ({ sensor: 'unscanned', severity: 'block', file: d.file, message: 'file is over 20 MB and was not scanned', fix: 'keep it out of the repo (gitignore it, or use LFS); a person can waive `unscanned` for it (a `size` waiver does not cover it)' }))
  // The vendored harness is rig's code, not the project's (harness-tamper watches it), so installing or upgrading it is never a size finding.
  const counted = diffs.filter(d => isSource(d.file, r.paths) && !d.binary && !isProtected(d.file))
  for (const d of counted.filter(f => f.status !== 'D')) {
    const now = fileLines[d.file]
    if (now === undefined) continue
    const before = now - d.added.length + d.removed.length
    if (now > limits.fileLines && before <= limits.fileLines) {
      findings.push({ sensor: 'size', severity: point === 'edit' || point === 'stop' ? 'block' : 'warn', file: d.file, message: `grew to ${now} lines (limit ${limits.fileLines})`, fix: 'split it by responsibility now: this file was within the limit before this change' })
    }
  }
  const total = counted.reduce((n, d) => n + d.added.length + d.removed.length, 0)
  if (total > limits.diffLines && point !== 'edit') {
    findings.push({
      sensor: 'size', severity: point === 'stop' ? 'warn' : 'block', message: `diff is ${total} changed lines (limit ${limits.diffLines})`,
      fix: `ship it as smaller changes, or the person approves the plan (${skillRef('approve')} <slug>) or waives with ${skillRef('waive')} size * <reason>`,
    })
  }
  if (point !== 'edit') {
    for (const d of counted) {
      const long = d.added.filter(l => l.text.length > limits.lineChars)
      if (!long.length) continue
      findings.push({
        sensor: 'size', severity: 'warn', file: d.file, line: long[0]?.n,
        message: `${long.length} added line(s) over ${limits.lineChars} characters (lines ${long.slice(0, 5).map(l => l.n).join(', ')}${long.length > 5 ? ', …' : ''})`,
        fix: 'one idea per line: name intermediate values instead of nesting expressions',
      })
    }
  }
  return findings
}

export function secretsInDiff(diffs: FileDiff[]): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => !f.binary)) {
    for (const l of d.added) {
      const hit = SECRET_PATTERNS.find(([, re]) => re.test(l.text))
      if (hit) findings.push({ sensor: 'secrets', severity: 'block', file: d.file, line: l.n, message: `possible ${hit[0]}`, fix: 'load it from the environment or a secret store; a deliberate test fixture goes under `fixtures` in .rig/sensors.json (a person approves that change)' })
    }
  }
  return findings
}

export function rulesSensor(diffs: FileDiff[], rules: { id: string; pattern: string; paths?: string[]; message: string; why: string; action: 'warn' | 'block' }[]): Finding[] {
  const findings: Finding[] = []
  for (const rule of rules) {
    const re = new RegExp(rule.pattern)
    for (const d of diffs.filter(f => !f.binary && !f.file.startsWith('.rig/') && (!rule.paths || matchesAny(f.file, rule.paths)))) {
      for (const l of d.added.filter(a => re.test(a.text))) {
        findings.push({ sensor: 'rules', severity: rule.action, file: d.file, line: l.n, message: `${rule.message} (${rule.why})`, fix: `follow rule ${rule.id} in .rig/rules.json`, labels: [rule.id] })
      }
    }
  }
  return findings
}

// rig-*.yml: every workflow rig writes (check, review, spec); a repo's own rig-*.yml counts too.
export const PROTECTED = ['.rig/sensors.json', '.rig/rules.json', '.rig/layers.approved.json', '.rig/gen/**', '.rig/ratchets.json', '.rig/verify/**', '.rig/lessons.md', '.rig/lessons-archive.md', '.rig/guides/**', '.rig/bin/**', '.rig/mod/**', '.rig/githooks/**', '.claude-plugin/**', 'CLAUDE.md', '.claude/**', '.github/workflows/rig-*.yml', '.github/workflows/sdlc-check.yml', 'CODEOWNERS', '.github/CODEOWNERS']
// ci: compare case-insensitively (macOS and Windows file systems treat CLAUDE.MD and CLAUDE.md as one file).
export const isProtected = (file: string, ci = false): boolean => (ci ? matchesAny(file.toLowerCase(), PROTECTED.map(p => p.toLowerCase())) : matchesAny(file, PROTECTED))
const RULES = '.rig/rules.json'

const removedFrom = (before: string[], after: string[]): string[] => before.filter(x => !after.includes(x))


export function weakensRules(beforeText: string, afterText: string): string[] {
  const b = parseRules(beforeText).rules
  const a = parseRules(afterText).rules
  const reasons = removedFrom(b.map(r => r.id), a.map(r => r.id)).map(id => `rule ${id} removed`)
  for (const r of b) if (r.action === 'block' && a.find(x => x.id === r.id)?.action === 'warn') reasons.push(`rule ${r.id} downgraded to warn`)
  return reasons
}

export function onlyKnownRedRemoved(beforeText: string, afterText: string): boolean {
  try {
    const b = JSON.parse(beforeText) as Record<string, unknown> & { knownRed?: string[] }
    const a = JSON.parse(afterText) as Record<string, unknown> & { knownRed?: string[] }
    const { knownRed: kb = [], ...restB } = b
    const { knownRed: ka = [], ...restA } = a
    return JSON.stringify(restA) === JSON.stringify(restB) && ka.every(k => kb.includes(k))
  } catch {
    return false
  }
}

export function harnessTamper(diffs: FileDiff[], o: { point: 'stop' | 'ship' | 'ci'; toolEdited?: Set<string>; before: (f: string) => string; after: (f: string) => string }): Finding[] {
  const findings: Finding[] = []
  for (const d of diffs.filter(f => isProtected(f.file))) {
    // At local ship (pre-push), a config the base never had is the commit that adopts rig: the person pushing it declares the
    // harness on their trunk, so it gets the plain review warning, or that first push could never pass. CI still compares it,
    // since a PR adding a config from scratch could declare no-op levels. Stop compares it as advice.
    const adopting = o.point === 'ship' && d.status === 'A' && !o.before(d.file).trim()
    const compare = (d.file === SENSORS_JSON || d.file === RULES || d.file === RATCHET_FILE) && !adopting
    const dirs = (): Record<string, 'down' | 'up'> => Object.fromEntries(parseRegistry(o.after(SENSORS_JSON)).registry.sensors.flatMap(s => (s.ratchet ? [[s.id, s.ratchet]] : [])))
    const weaker = !compare ? [] : d.file === SENSORS_JSON ? weakensRegistry(o.before(d.file), o.after(d.file)) : d.file === RATCHET_FILE ? weakensRatchets(o.before(d.file), o.after(d.file), dirs()) : weakensRules(o.before(d.file), o.after(d.file))
    const reasons = d.status === 'D' ? [`${d.file} deleted`, ...weaker] : weaker
    if (o.point === 'stop') {
      if (o.toolEdited && !o.toolEdited.has(d.file)) {
        if (d.file === SENSORS_JSON && onlyKnownRedRemoved(o.before(d.file), o.after(d.file))) continue
        findings.push({ sensor: 'harness-tamper', severity: 'block', file: d.file, message: 'harness file changed outside Write/Edit (via Bash?)', fix: `revert it (git checkout -- ${d.file}), or ask the person to make this change` })
      } else if (reasons.length) {
        findings.push({ sensor: 'harness-tamper', severity: 'warn', file: d.file, message: reasons.join('; '), fix: 'the person allowed this edit; it shows in the review brief', labels: ['weakens-harness'] })
      }
      continue
    }
    findings.push(reasons.length
      ? { sensor: 'harness-tamper', severity: 'block', file: d.file, message: reasons.join('; '), fix: `declare it on the trunk first: a separate harness change to ${d.file}, reviewed by the code owners; then rebase this change (CI never accepts a harness waiver from the PR)`, labels: ['weakens-harness'] }
      : { sensor: 'harness-tamper', severity: 'warn', file: d.file, message: 'harness file changed', fix: 'needs human review; if it changes how the agent works (CLAUDE.md, .claude/**, guides, rules), commit it on the branch, ask the person to review it' })
  }
  return findings
}

export const behaviourIds = (text: string, heading: string): string[] => [...new Set(section(text, heading).match(/\bB\d+\b/g) ?? [])]

// The rest of the line after the id, so a block says what the behaviour is.
export function behaviourText(text: string, heading: string, id: string): string {
  const line = section(text, heading).split('\n').find(l => new RegExp(`\\b${id}\\b`).test(l)) ?? ''
  return line.slice(line.search(new RegExp(`\\b${id}\\b`)) + id.length).replace(/^[\s:.\-–—)]+/, '').trim().slice(0, 80)
}

export const missingBehaviours = (ids: string[], corpus: string): string[] => ids.filter(id => !new RegExp(`(?<![A-Za-z0-9])${id}(?!\\d)`).test(corpus))
