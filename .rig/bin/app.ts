// `sdlc app` (harness readiness 2.1, design 2026-10-21): journeys. A repo-local driver launches the real app, walks a few named journeys and
// exits 0 or 1; a person approves it once; from then on verify, ship and CI run it, and a failed journey blocks. The driver is any command, so
// nothing here assumes what kind of app it is. A driver nobody has approved is a draft: not enforced, and listed as such.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { ROOT, SDLC, PLUGIN_ROOT, ownerOrFail, out, fail, read, readJson, BUDGET_MS, exists, sha, writeAtomic, sanctionWrites, skillRef, type Args } from './core.ts'
import { runCommand } from './runs.ts'
import { formatFindings, type Finding } from './model.ts'
import type { Inert } from './registry.ts'

const VERIFY = '.rig/verify'
export type App = { name: string; run: string; files: string[]; timeoutMs: number }
type AppState = 'draft' | 'current' | 'changed' | 'stale'
type Approval = { by: string; at: string; hash: string }

const readRel = <T>(rel: string): T | null => readJson<T | null>(path.join(ROOT, rel), null)

const UNSAFE = /(^|\/)\.\.(\/|$)|^\//
const appDirs = (): string[] => (exists(path.join(ROOT, VERIFY)) ? fs.readdirSync(path.join(ROOT, VERIFY), { withFileTypes: true }).filter(d => d.isDirectory() && /^[a-z0-9][a-z0-9-]*$/.test(d.name)).map(d => d.name) : [])

function listApps(): App[] {
  return appDirs().flatMap(name => {
    const def = readRel<{ run?: unknown; files?: unknown; timeoutMs?: unknown }>(`${VERIFY}/${name}/app.json`)
    if (!def || typeof def.run !== 'string' || !def.run.trim() || !Array.isArray(def.files)) return []
    return [{ name, run: def.run, files: def.files.filter((f): f is string => typeof f === 'string' && !UNSAFE.test(f)), timeoutMs: Number(def.timeoutMs) > 0 ? Number(def.timeoutMs) : 120_000 }]
  })
}

// What would otherwise switch a journey off in silence: an app.json that does not read, a driver file it names that is missing, an approval
// whose app is gone.
function appProblems(): string[] {
  const apps = listApps().map(a => a.name)
  const out: string[] = []
  for (const name of appDirs().filter(n => exists(path.join(ROOT, VERIFY, n, 'app.json')) && !apps.includes(n))) out.push(`${name}: app.json is not valid (it needs a non-empty "run" and a "files" list of paths inside the app folder)`)
  for (const a of listApps()) for (const f of a.files) if (!exists(path.join(ROOT, VERIFY, a.name, f))) out.push(`${a.name}: the driver file ${f} does not exist`)
  if (exists(path.join(ROOT, VERIFY))) for (const f of fs.readdirSync(path.join(ROOT, VERIFY)).filter(f => f.endsWith('.approved.json'))) if (!apps.includes(f.replace(/\.approved\.json$/, ''))) out.push(`${f}: approves an app that is not there (renamed or deleted), so its journeys are no longer run`)
  return out
}

const featureFiles = (a: App): string[] => {
  const dir = path.join(ROOT, VERIFY, a.name, 'features')
  return exists(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => `${VERIFY}/${a.name}/features/${f}`) : []
}
// Everything that makes the journeys what they are: the definition, the driver files, the shared helper they import, and the feature map.
const hashOf = (a: App): string => sha([`${VERIFY}/${a.name}/app.json`, ...a.files.map(f => `${VERIFY}/${a.name}/${f}`), `${VERIFY}/lib.mjs`, ...featureFiles(a)].map(f => `${f}\n${read(path.join(ROOT, f))}`).join('\n--\n'))
const approvalOf = (a: App): Approval | null => readRel<Approval>(`${VERIFY}/${a.name}.approved.json`)

// A feature file says where its feature lives with `entry: <path>` lines; a path that no longer exists means the map has gone stale.
function missingEntries(a: App): string[] {
  return featureFiles(a).flatMap(f => [...read(path.join(ROOT, f)).matchAll(/^entry:\s*(\S+)\s*$/gm)].map(m => m[1] as string).filter(p => !exists(path.join(ROOT, p))).map(p => `${path.basename(f)}: ${p}`))
}

function appState(a: App): AppState {
  const ap = approvalOf(a)
  if (!ap) return 'draft'
  if (missingEntries(a).length) return 'stale'
  return ap.hash === hashOf(a) ? 'current' : 'changed'
}

export const draftApps = (): Inert[] => listApps().filter(a => appState(a) === 'draft').map(a => ({ id: 'journeys', reason: `${a.name} is a draft: never approved, so not enforced` }))
export const appStates = (): { name: string; state: AppState }[] => listApps().map(a => ({ name: a.name, state: appState(a) }))

// The driver runs with a clean environment: no tokens or secrets the checker was given, and its own state directory.
const SECRETISH = /TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|^SDLC_|^GH_|^GITHUB_|^ACTIONS_/i

// Kills the process groups a driver recorded in its pids file (the app it launched, in its own group) and nothing else: a driver that was
// killed on a timeout cannot clean up after itself.
function reap(stateDir: string): void {
  const file = path.join(stateDir, 'pids')
  for (const pid of read(file).split('\n').map(Number).filter(n => Number.isInteger(n) && n > 1)) { try { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(file, { force: true })
}

function runDriver(a: App, budgetMs: number): { exit: number; tail: string; timedOut: boolean } {
  const stateDir = path.join(SDLC, 'state', 'verify', a.name)
  fs.mkdirSync(stateDir, { recursive: true })
  reap(stateDir)
  fs.rmSync(path.join(stateDir, 'evidence.json'), { force: true })
  const row = runCommand(a.run, { timeoutMs: Math.max(1000, Math.min(a.timeoutMs, budgetMs)), env: { RIG_VERIFY_STATE: stateDir }, unsetEnv: SECRETISH })
  reap(stateDir)
  // Exit 0 is not enough: the driver must say what it checked. No evidence, or none that holds, is a failed run.
  const evidence = readJson<{ ok?: boolean; steps?: unknown[] } | null>(path.join(stateDir, 'evidence.json'), null)
  const hollow = row.exit === 0 && !(evidence?.ok === true && Array.isArray(evidence.steps) && evidence.steps.length > 0)
  return { exit: hollow ? 1 : row.exit, tail: hollow ? `${row.tail}\nthe driver exited 0 but wrote no evidence of any journey step to $RIG_VERIFY_STATE/evidence.json` : row.tail, timedOut: Boolean(row.timedOut) }
}

// What verify, ship and CI run: every approved app's driver. A draft is skipped.
export function journeyFindings(budgetMs: number, only?: string, ci = false): Finding[] {
  const findings: Finding[] = appProblems().map(m => ({ sensor: 'journeys', severity: 'block' as const, message: `journeys: ${m}`, fix: 'fix or remove it in a reviewed change' }))
  let left = budgetMs
  for (const a of listApps().filter(x => !only || x.name === only)) {
    const state = appState(a)
    if (state === 'draft') continue
    if (state === 'stale') findings.push({ sensor: 'journeys', severity: 'block', message: `journeys ${a.name}: the feature map names a path that no longer exists (${missingEntries(a).join('; ')})`, fix: 'update the feature files for what the app is now, then `app approve` again' })
    if (state === 'changed') findings.push({ sensor: 'journeys', severity: 'warn', message: `journeys ${a.name} changed since a person approved it${ci ? ' and was not run: CI runs only approved journeys, because the PR supplies the command' : ''}`, fix: 'a code owner reviews the driver and feature files; `app approve` records the new version', labels: ['weakens-harness'] })
    // CI holds secrets and runs the checker from the base branch; the command here comes from the PR, so only bytes a person approved run there.
    if (ci && state === 'changed') continue
    if (left <= 0) { findings.push({ sensor: 'journeys', severity: 'block', message: `journeys ${a.name} not run: the time budget ran out`, fix: 'raise the budget or make the driver faster', outOfTime: true }); continue }
    const t0 = Date.now()
    const r = runDriver(a, left)
    left -= Date.now() - t0
    if (r.exit !== 0) findings.push({ sensor: 'journeys', severity: 'block', message: `a journey of ${a.name} failed (exit ${r.exit}${r.timedOut ? ', timed out' : ''}):\n${r.tail.split('\n').slice(-12).map(l => `      ${l}`).join('\n')}`, fix: `fix the app; the journey is how a person uses it. Rerun: ${a.run}`, ...(r.timedOut ? { outOfTime: true as const } : {}) })
  }
  return findings
}

const pick = (args: Args, apps: App[]): App => {
  const name = args.pos[1]
  const a = name ? apps.find(x => x.name === name) : apps.length === 1 ? apps[0] : undefined
  if (!a) fail(apps.length ? `name the app: ${apps.map(x => x.name).join(', ')}` : `no app under .rig/verify/<name>/app.json; run ${skillRef('app')}`)
  return a as App
}

export function cmdApp(args: Args): void {
  const sub = args.pos[0]
  const apps = listApps()
  if (sub === 'init') {
    fs.mkdirSync(path.join(ROOT, VERIFY), { recursive: true })
    writeAtomic(path.join(ROOT, VERIFY, 'lib.mjs'), read(path.join(PLUGIN_ROOT, 'templates', 'verify', 'lib.mjs')))
    sanctionWrites([`${VERIFY}/lib.mjs`])
    return out(`wrote ${VERIFY}/lib.mjs: the optional Node helper (launch, verify). A driver in any language works; see ${skillRef('app')}.`)
  }
  if (sub === 'status') {
    const states = appStates()
    if (args.opt.json) return out(JSON.stringify(states))
    return out(states.length ? states.map(s => `${s.name}: ${({ draft: 'draft (never approved, not enforced)', current: 'current', changed: 'changed since approved (review it)', stale: 'stale (the feature map names a missing path)' })[s.state]}`).join('\n') : `journeys: not configured (run ${skillRef('app')})`)
  }
  if (sub === 'run') {
    const a = pick(args, apps)
    const r = runDriver(a, a.timeoutMs)
    out(r.tail)
    process.exitCode = r.exit === 0 ? 0 : 1
    return
  }
  if (sub === 'approve') {
    if (process.env.SDLC_HUMAN !== '1') fail('journey approvals are human-only: the person runs `! SDLC_HUMAN=1 node .rig/bin/sdlc.ts app approve <app>`', 3)
    const a = pick(args, apps)
    const by = ownerOrFail(args, 'journey approvals')
    const miss = missingEntries(a)
    if (miss.length) fail(`not approving: the feature map names a path that does not exist: ${miss.join('; ')}`)
    const r = runDriver(a, a.timeoutMs)
    if (r.exit !== 0) fail(`not approving: a journey failed (exit ${r.exit}${r.timedOut ? ', timed out' : ''}):\n${r.tail}`)
    writeAtomic(path.join(ROOT, VERIFY, `${a.name}.approved.json`), JSON.stringify({ by, at: new Date().toISOString(), hash: hashOf(a) } satisfies Approval, null, 2) + '\n')
    sanctionWrites([`${VERIFY}/${a.name}.approved.json`])
    return out(`journeys ${a.name} approved by ${by}: the driver passed, and verify, ship and CI now run it.`)
  }
  if (sub === 'check') {
    if (args.pos[1] && !apps.some(a => a.name === args.pos[1])) fail(`no such app: ${args.pos[1]}${apps.length ? ` (known: ${apps.map(a => a.name).join(', ')})` : ''}`)
    const found = journeyFindings(BUDGET_MS.ci, args.pos[1])
    out(formatFindings(found) || (apps.length ? 'journeys: pass' : 'journeys: not configured'))
    process.exitCode = found.some(f => f.severity === 'block') ? 1 : 0
    return
  }
  fail('usage: app (init | run | status | approve | check) [<app>]')
}
