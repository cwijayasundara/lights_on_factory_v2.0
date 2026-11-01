import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { installBuildMode, runAcceptanceWriter } from './install-build-mode.ts'

// Paired experiment (roadmap step 5): does each harness layer earn its cost?
//   a = no harness   b = current build mode   c = build mode + protected acceptance suite
// Every arm is graded by one hidden suite written once by a separate session. Cost is what the CLI
// bills (total_cost_usd, subagents included). A ledger stops the run before the budget is spent.

export type Arm = 'a' | 'b' | 'c'
export type Grade = { tests: number; passed: number; skipped: number }
export type Row = {
  arm: Arm
  run: number
  accepted: boolean
  passed: number
  tests: number
  costUsd: number | null
  wallSeconds: number
  turns: number | null
  blocks: number
  timedOut: boolean
  sessionId: string | null
}
export type Options = {
  factoryRoot: string
  spec: string
  demo: string
  out: string
  arms: Arm[]
  runs: number
  budgetUsd: number
  perRunUsd: number
  writerModel: string
  builderModel: string
  effort: string
  timeoutMinutes: number
  dryRun?: boolean
  grader?: (dir: string, suite: string) => Grade
}

const WRITER_RESERVE_USD = 1
const BUILD_PROMPT_NO_HARNESS = 'Build this project from SPEC.md. Never ask the operator anything. Keep going until the project is finished and its demo command works.'

type Ledger = { spentUsd: number; entries: { what: string; usd: number }[] }

const claudeBin = () => process.env.LIGHTS_ON_CLAUDE ?? 'claude'

function run(cwd: string, command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function spend(out: string, ledger: Ledger, what: string, usd: number): void {
  ledger.spentUsd = Math.round((ledger.spentUsd + usd) * 1e6) / 1e6
  ledger.entries.push({ what, usd })
  fs.writeFileSync(path.join(out, 'ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`)
}

// May another run start? Its worst case is the per-run cap.
export function canStart(spentUsd: number, perRunUsd: number, budgetUsd: number): boolean {
  return spentUsd + perRunUsd <= budgetUsd
}

export function worstCase(options: Pick<Options, 'arms' | 'runs' | 'perRunUsd'>): number {
  const writers = (options.arms.includes('c') ? 2 : 1) * WRITER_RESERVE_USD
  return writers + options.arms.length * options.runs * options.perRunUsd
}

function newRepo(dir: string, spec: string): void {
  fs.mkdirSync(dir, { recursive: true })
  run(dir, 'git', ['init', '-q', '-b', 'main'])
  run(dir, 'git', ['config', 'user.email', 'experiment@example.com'])
  run(dir, 'git', ['config', 'user.name', 'Experiment'])
  fs.copyFileSync(spec, path.join(dir, 'SPEC.md'))
  run(dir, 'git', ['add', '-A'])
  run(dir, 'git', ['commit', '-q', '-m', 'docs: approved spec'])
}

// Two independent writer sessions: `grading` is hidden from every builder, `visible` is arm c's treatment.
function prepareSuite(options: Options, ledger: Ledger, name: 'grading' | 'visible'): string {
  const suite = path.join(options.out, 'suites', name)
  if (fs.existsSync(suite)) return suite
  const scratch = path.join(options.out, 'work', `writer-${name}`)
  newRepo(scratch, options.spec)
  const previous = process.env.LIGHTS_ON_ACCEPTANCE_MODEL
  process.env.LIGHTS_ON_ACCEPTANCE_MODEL = options.writerModel
  try {
    runAcceptanceWriter(options.factoryRoot, scratch)
  } finally {
    if (previous === undefined) delete process.env.LIGHTS_ON_ACCEPTANCE_MODEL
    else process.env.LIGHTS_ON_ACCEPTANCE_MODEL = previous
  }
  fs.mkdirSync(path.dirname(suite), { recursive: true })
  fs.cpSync(path.join(scratch, 'acceptance'), suite, { recursive: true })
  spend(options.out, ledger, `writer ${name} (reserved upper bound)`, WRITER_RESERVE_USD)
  return suite
}

function prepareArm(options: Options, arm: Arm, n: number, visibleSuite: string | null): string {
  const dir = path.join(options.out, 'work', `${arm}${n}`)
  fs.rmSync(dir, { recursive: true, force: true })
  newRepo(dir, options.spec)
  if (arm === 'c' && visibleSuite) {
    fs.cpSync(visibleSuite, path.join(dir, 'acceptance'), { recursive: true })
    run(dir, 'git', ['add', '-A'])
    run(dir, 'git', ['commit', '-q', '-m', 'docs: acceptance suite'])
  }
  if (arm !== 'a') installBuildMode({ target: dir, factoryRoot: options.factoryRoot, demo: options.demo })
  return dir
}

function build(options: Options, arm: Arm, dir: string) {
  const prompt = arm === 'a' ? BUILD_PROMPT_NO_HARNESS : fs.readFileSync(path.join(dir, '.factory/build-prompt.txt'), 'utf8').trim()
  const args = [
    '-p', prompt, '--output-format', 'json', '--setting-sources', 'project', '--permission-mode', 'auto',
    '--model', options.builderModel, '--effort', options.effort, '--max-budget-usd', String(options.perRunUsd),
  ]
  const began = Date.now()
  const result = spawnSync(claudeBin(), args, { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: options.timeoutMinutes * 60_000 })
  let report: { total_cost_usd?: number; session_id?: string; num_turns?: number } = {}
  try {
    report = JSON.parse(result.stdout?.trim().split('\n').at(-1) ?? '')
  } catch {
    // no parsable report: cost stays null and is charged at the per-run cap
  }
  return {
    costUsd: typeof report.total_cost_usd === 'number' ? report.total_cost_usd : null,
    sessionId: report.session_id ?? null,
    turns: report.num_turns ?? null,
    wallSeconds: Math.round((Date.now() - began) / 1000),
    timedOut: result.error?.message.includes('ETIMEDOUT') ?? false,
  }
}

function defaultGrader(dir: string, suite: string): Grade {
  const report = path.join(dir, 'target/grade.xml')
  fs.rmSync(report, { force: true })
  spawnSync('uv', ['run', 'python', '-B', '-m', 'pytest', suite, '-q', '-p', 'no:cacheprovider', `--junitxml=${report}`], { cwd: dir, encoding: 'utf8' })
  if (!fs.existsSync(report)) return { tests: 0, passed: 0, skipped: 0 }
  const xml = fs.readFileSync(report, 'utf8')
  const attr = (name: string) => Number(new RegExp(`<testsuite[^>]*\\b${name}="(\\d+)"`).exec(xml)?.[1] ?? 0)
  const tests = attr('tests')
  const bad = attr('failures') + attr('errors') + attr('skipped')
  return { tests, passed: Math.max(tests - bad, 0), skipped: attr('skipped') }
}

function countBlocks(dir: string): number {
  const log = path.join(dir, '.factory/hook-log.jsonl')
  if (!fs.existsSync(log)) return 0
  return fs.readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"decision":"block"')).length
}

export function summarize(rows: Row[]) {
  return (['a', 'b', 'c'] as Arm[])
    .map(arm => {
      const mine = rows.filter(row => row.arm === arm)
      if (mine.length === 0) return null
      const accepted = mine.filter(row => row.accepted).length
      const known = mine.filter(row => row.costUsd !== null)
      const total = known.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
      return {
        arm,
        runs: mine.length,
        accepted,
        meanCostUsd: known.length ? total / known.length : null,
        costPerAcceptedUsd: accepted > 0 && known.length === mine.length ? total / accepted : null,
        meanWallSeconds: Math.round(mine.reduce((sum, row) => sum + row.wallSeconds, 0) / mine.length),
        meanBlocks: mine.reduce((sum, row) => sum + row.blocks, 0) / mine.length,
      }
    })
    .filter(<T,>(row: T | null): row is T => row !== null)
}

const money = (value: number | null) => (value === null ? 'n/a' : `$${value.toFixed(2)}`)

export function renderReport(rows: Row[], ledger: Ledger, options: Pick<Options, 'budgetUsd' | 'builderModel' | 'effort'>): string {
  const lines = [
    '# Experiment report',
    '',
    `Builder ${options.builderModel} at effort ${options.effort}. Spent ${money(ledger.spentUsd)} of ${money(options.budgetUsd)} (writer sessions counted at an upper bound).`,
    '',
    '| arm | runs | accepted | mean cost | cost per accepted | mean wall (s) | mean blocks |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summarize(rows).map(s => `| ${s.arm} | ${s.runs} | ${s.accepted}/${s.runs} | ${money(s.meanCostUsd)} | ${money(s.costPerAcceptedUsd)} | ${s.meanWallSeconds} | ${s.meanBlocks.toFixed(1)} |`),
    '',
    'Accepted means every test in the hidden grading suite passed. With few runs per arm these are observations, not significance.',
  ]
  return `${lines.join('\n')}\n`
}

export function runExperiment(options: Options): { rows: Row[]; ledger: Ledger } {
  fs.mkdirSync(options.out, { recursive: true })
  const ledger = readJson<Ledger>(path.join(options.out, 'ledger.json'), { spentUsd: 0, entries: [] })
  const resultsFile = path.join(options.out, 'results.jsonl')
  const rows: Row[] = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  if (options.dryRun) return { rows, ledger }

  const grading = prepareSuite(options, ledger, 'grading')
  const visible = options.arms.includes('c') ? prepareSuite(options, ledger, 'visible') : null
  for (let n = 1; n <= options.runs; n += 1) {
    for (const arm of options.arms) {
      if (rows.some(row => row.arm === arm && row.run === n)) continue
      if (!canStart(ledger.spentUsd, options.perRunUsd, options.budgetUsd)) {
        process.stderr.write(`budget guard: ${ledger.spentUsd.toFixed(2)} spent, another run could reach ${options.budgetUsd}; stopping\n`)
        fs.writeFileSync(path.join(options.out, 'report.md'), renderReport(rows, ledger, options))
        return { rows, ledger }
      }
      const dir = prepareArm(options, arm, n, visible)
      const built = build(options, arm, dir)
      spend(options.out, ledger, `build ${arm}${n}`, built.costUsd ?? options.perRunUsd)
      const grade = (options.grader ?? defaultGrader)(dir, grading)
      const row: Row = {
        arm, run: n, accepted: grade.tests > 0 && grade.passed === grade.tests, passed: grade.passed, tests: grade.tests,
        costUsd: built.costUsd, wallSeconds: built.wallSeconds, turns: built.turns, blocks: countBlocks(dir), timedOut: built.timedOut, sessionId: built.sessionId,
      }
      rows.push(row)
      fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`)
    }
  }
  fs.writeFileSync(path.join(options.out, 'report.md'), renderReport(rows, ledger, options))
  return { rows, ledger }
}

function main(argv: string[]): number {
  const flag = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const spec = flag('spec')
  const demo = flag('demo')
  const out = flag('out')
  if (!spec || !demo || !out) {
    process.stderr.write('usage: node scripts/run-experiment.ts --spec SPEC.md --demo "<cmd>" --out <dir> [--arms a,b,c] [--runs 1] [--budget 16] [--per-run 4] [--dry-run]\n')
    return 2
  }
  const options: Options = {
    factoryRoot: path.resolve(import.meta.dirname, '..'),
    spec: path.resolve(spec), demo, out: path.resolve(out),
    arms: flag('arms', 'a,b,c')!.split(',') as Arm[],
    runs: Number(flag('runs', '1')), budgetUsd: Number(flag('budget', '16')), perRunUsd: Number(flag('per-run', '4')),
    writerModel: flag('writer-model', 'claude-opus-5-5')!, builderModel: flag('builder-model', 'claude-sonnet-5-5')!,
    effort: flag('effort', 'medium')!, timeoutMinutes: Number(flag('timeout-minutes', '90')), dryRun: argv.includes('--dry-run'),
  }
  const worst = worstCase(options)
  process.stdout.write(`plan: arms ${options.arms.join(',')} x ${options.runs} run(s); worst case ${money(worst)} against a budget of ${money(options.budgetUsd)}\n`)
  if (options.dryRun) return 0
  const { rows, ledger } = runExperiment(options)
  process.stdout.write(`${renderReport(rows, ledger, options)}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) process.exitCode = main(process.argv.slice(2))
