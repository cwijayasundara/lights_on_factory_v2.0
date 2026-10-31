#!/usr/bin/env node
// rig: the deterministic core of the sdlc plugin. Zero dependencies.
// Runs directly with Node >= 22.18 (built-in TypeScript type stripping) on macOS, Linux and Windows:
//   node --disable-warning=ExperimentalWarning scripts/sdlc.ts <command>
// Everything the model must not judge for itself lives in these scripts: change state, approvals,
// scope drift, sensors and hook decisions. This file is the CLI.
import fs from 'node:fs'
import path from 'node:path'
import { waiverLive, whoami, ownerOrFail,
  ROOT, SDLC, CHANGES, SLUG_RE, SOFT_HOOK_FAILURE, exists, read, now, defaultBase, isTrunk, trunkName, toPosix, out, fail, git, parseArgs, optString, listChanges, ageDays, dirtyFiles, readUnresolved, checkSlug,
  WAIVERS, readJsonl, type Waiver, ensureGitignore, PLUGIN_ROOT, IS_VENDORED, skillRef, sanctionWrites, readGate, type Args,
} from './core.ts'
import { formatFindings, SENSOR_NAMES } from './model.ts'
import { readBaseline, branchDiff, turnDiff, type Snapshot } from './diffs.ts'
import { cmdHook } from './hooks.ts'
import { cmdCheck, cmdCheckFile, loadConfig } from './check.ts'
import { inertSensors, isRegistryShape, type Inert } from './registry.ts'
import { runCommand, recordRun } from './runs.ts'
import { cmdVendor, installStandalone, older, pluginVersion } from './vendor.ts'
import { cmdUpgrade } from './upgrade.ts'
import { cmdBaseline } from './initbaseline.ts'
import { cmdVerify } from './verify.ts'
import { cmdHooks, cmdCheckPush } from './githooks.ts'
import { cmdPr } from './pr.ts'
import { cmdCarry } from './carry.ts'
import { treeStamp } from './stamp.ts'
import { declareStack } from './stackinit.ts'
import { cmdSync } from './sync.ts'
import { cmdWiki } from './wiki.ts'
import { cmdLearn } from './learn.ts'
import { cmdReport } from './report.ts'
import { cmdArch, layerState, layerStateText } from './arch.ts'
import { cmdQueue, conflictsFor } from './queue.ts'
import { intentScope } from './scope.ts'
import { prdFormatProblems, prdLedger, conversionProblems } from './prdformat.ts'
import { parseLedger, parseIntent } from './chartcheck.ts'
import { superpowersWarning } from './superpowers.ts'
import { ARCH_REL, intentsDir, intentRelOf, prdRel, sprintRel, prdPath, reviewPath, ledgerPath, sourcePath, conversionPath } from './product.ts'
import { cmdSlice } from './slice.ts'
import { registerContracts } from './contracts.ts'
import { cmdMaintain } from './maintain.ts'
import { cmdReadiness } from './readiness.ts'
import { cmdAutonomy, initAutonomy } from './autonomy.ts'
import { cmdRisk, cmdWeight } from './risk.ts'
import { protect } from './protect.ts'
import { cmdApp, draftApps, appStates } from './app.ts'
import { CHART_RE, intentOf, intentReady, chartFindings, chartState, writeChartApproval, chartReport, readyIntents, planRows, writePlan, sprintPlan, chartFiles, intentSettled, nextChart, sprintsKnown, sprintIntents, chartReview, chartOpenFindings, waiveChartFinding, changeRequirements, PRD_RE, isConverted, conversionRefusal } from './chart.ts'
import { journey, journeyText } from './journey.ts'
import { TYPES, changeDir, newChange, setActive, activeSlug, isShipped, status, nextStep, changeType, approvalRefusal, approvalState, readApproval, freezeRecord, writeApproval } from './lifecycle.ts'

// ---------- commands ----------

// NaN (a missing or unreadable date) is treated as infinitely old, so it can never hide from the stale check.
const STALE_WAIVER_DAYS = 30
const MAX_WAIVER_DAYS = 180
const expiryText = (w: Waiver): string => (!w.expires ? 'no expiry' : !waiverLive(w) ? 'expired' : `expires in ${Math.max(1, Math.ceil((Date.parse(w.expires) - Date.now()) / 86_400_000))}d`)

// An install older than this plugin is upgraded, not re-initialised (design 2026-10-26-rig-upgrade); `--full` takes the same way out.
function upgradePointer(): string | null {
  const have = read(path.join(SDLC, 'bin', 'VERSION')).trim()
  return have && !IS_VENDORED && older(have, pluginVersion()) ? `.rig/bin is ${have}, older than this plugin (${pluginVersion()}): nothing was changed. Run /rig:upgrade from the newer plugin to bring it up to date.` : null // plugin-only: the upgrade skill is not vendored, so no skillRef
}

function cmdInit(args: Args): void {
  // Ship and the PR gate read git, so a directory outside any repo gets one.
  const newRepo = git(['rev-parse', '--is-inside-work-tree']) !== 'true' && git(['init', '-q', '-b', 'main']) !== null
  fs.mkdirSync(CHANGES, { recursive: true })
  ensureGitignore()
  initAutonomy()
  const guides = path.join(SDLC, 'guides')
  if (!exists(guides) && exists(path.join(PLUGIN_ROOT, 'guides'))) {
    fs.cpSync(path.join(PLUGIN_ROOT, 'guides'), guides, { recursive: true })
    sanctionWrites(fs.readdirSync(guides).map(f => `.rig/guides/${f}`))
  }
  out(`initialised ${toPosix(path.relative(ROOT, SDLC)) || SDLC}${newRepo ? ' (ran git init: no repository was here)' : ''}`)
  if (args.opt.stack) out(declareStack(args.opt.stack))
  if (args.opt.full) out(installStandalone(Boolean(args.opt.workflows)))
  if (args.opt.protect) out(protect(Boolean(args.opt.dry)).join('\n'))
  if (args.opt.enforce) {
    // risk.enforce on (never off): rig-check then wants an approval from someone other than the author on every PR. The rest of the file is kept.
    const file = path.join(SDLC, 'sensors.json')
    let j: Record<string, unknown> = {}
    try { j = JSON.parse(read(file) || '{}') as Record<string, unknown> } catch { fail('.rig/sensors.json is not JSON; fix it before init --enforce') }
    // Only a registry: a bare {"risk":…} would be overwritten by a later init --stack, silently dropping enforce.
    if (!isRegistryShape(read(file))) fail('.rig/sensors.json is not a sensor registry yet: run init --stack first, then init --enforce')
    j.risk = { ...(typeof j.risk === 'object' && j.risk ? j.risk : {}), enforce: true }
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
    sanctionWrites(['.rig/sensors.json'])
    out('risk.enforce is on: rig-check now wants an approval of the head commit from someone other than the author on every PR')
  }
  const me = whoami()
  out(me ? `approvals and waivers are recorded as "${me}" (git user.name); change it with: git config user.name "<name>"` : 'no user name found: set one with `git config user.name "<name>"` so approvals say who approved')
}

// Tells /rig:start whether the charted intent leaves anything to ask (F2 of the 2026-10-29 feedback proposal).
const settledLine = (slug: string): string => { const s = intentSettled(slug); return s.settled ? `settled: yes (the intent answers everything ${skillRef('start')} would ask)` : `settled: no (${s.why.join('; ')})` }

function cmdNew(args: Args): void {
  const slug = args.pos[0] ?? ''
  if (!SLUG_RE.test(slug)) fail(`usage: new <kebab-slug> [--type ${TYPES.join('|')}] [--title "..."] [--source .rig/product/sprints/sprint-<N>/intents/<slug>.md] [--full] [--from-diff]`)
  const raw = optString(args, 'type') ?? 'feature'
  const type = TYPES.find(t => t === raw)
  if (!type) fail(`usage: new <slug> [--type ${TYPES.join('|')}] [--title "..."]`)
  if (exists(changeDir(slug))) fail(`${slug} already exists: ${skillRef('start')} ${slug} continues it`)
  const source = optString(args, 'source')
  const captured = args.opt['from-diff'] === true ? capturedWork() : null
  if (captured && source) fail('--from-diff captures work already done; a charted intent starts with --source alone')
  if (captured && !captured.diffs.length) fail(`nothing to capture: no file differs from ${captured.base}`)
  if (source) {
    const rel = toPosix(path.relative(ROOT, path.resolve(ROOT, source)))
    const expected = intentRelOf(slug)
    if (rel !== expected) fail(`the slug must equal the intent's: new ${slug} --source ${rel} (expected ${expected ?? `.rig/product/sprints/sprint-<N>/intents/${slug}.md`})`)
    const ready = intentReady(slug)
    if (!ready.ready) fail(`${slug} cannot start:\n${ready.why.map(w => `  - ${w}`).join('\n')}${blockedHint(slug)}`)
  }
  if (!exists(SDLC)) cmdInit({ pos: [], opt: {} })
  ensureGitignore()
  const intent = source ? intentOf(slug) : null
  const title = optString(args, 'title') ?? (source ? /^#\s+(.+)$/m.exec(read(path.resolve(ROOT, source)))?.[1] : undefined) ?? slug
  newChange(slug, type, title, source && toPosix(path.relative(ROOT, path.resolve(ROOT, source))), args.opt.full === true)
  if (intent) fs.writeFileSync(path.join(changeDir(slug), 'spec.md'), `# Spec: ${title}\n\n## Behaviours\n${intent.behaviours.map(b => { const ids = [...new Set([...b.reqs, ...b.rules])]; return `- ${b.id}${ids.length ? ` (${ids.join(', ')})` : ''}: ${b.text}` }).join('\n')}\n\n## Out of scope\n\n## Open questions\nnone\n`)
  const reqs = intent ? changeRequirements(slug) : null
  if (reqs) fs.writeFileSync(path.join(changeDir(slug), 'requirements.md'), reqs)
  if (captured) {
    const file = path.join(changeDir(slug), 'intent.md')
    fs.writeFileSync(file, read(file).replace('\n---\n# ', `\nfrom-diff: ${captured.base}\n---\n# `))
    fs.writeFileSync(path.join(changeDir(slug), 'spec.md'), `# Spec: ${title}\n\n## Behaviours\n\n## Blast radius\n${[...new Set(captured.diffs.flatMap(d => (d.from ? [d.from, d.file] : [d.file])))].map(f => `- ${f.replace(/ /g, '?')}`).join('\n')}\n\n## Out of scope\n\n## Open questions\nnone\n`)
  }
  out(`created .rig/changes/${slug}/intent.md (type ${type}); ${slug} is the active change${intent ? `; spec.md starts with the ${intent.behaviours.length} behaviour(s) of the intent` : ''}${reqs ? `; requirements.md holds the PRD rows it cites` : ''}${intent ? `\n${settledLine(slug)}` : ''}`)
  if (captured) out([`captured ${captured.diffs.length} file(s) changed since ${captured.base.slice(0, 7)} (spec.md's blast radius starts with them):`, ...captured.diffs.map(d => `  ${d.file} +${d.added.length} -${d.removed.length}`), ...(captured.warning ? [`WARNING: ${captured.warning}`] : [])].join('\n'))
}

// --from-diff: the work done so far, committed on this branch or not, against the base it started from. On the trunk the base is
// the remote trunk, so local commits count as work; with no remote, they are already the base and only uncommitted work is captured.
function capturedWork(): { base: string; diffs: ReturnType<typeof branchDiff>; warning?: string } {
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
  const remote = isTrunk(head) && git(['rev-parse', '--verify', '--quiet', `origin/${head}`]) ? git(['merge-base', 'HEAD', `origin/${head}`]) : null
  const found = isTrunk(head) ? remote : defaultBase()
  const base = found ?? git(['rev-parse', 'HEAD']) ?? 'HEAD'
  const warning = found ? undefined : isTrunk(head) ? `${head} has no origin/${head}: commits already on ${head} count as the base, so only uncommitted work is captured and red-proof judges the new tests against that` : `no main or master to compare ${head} with: its commits count as the base, so only uncommitted work is captured`
  return { base, diffs: branchDiff(base).filter(d => !d.file.startsWith('.rig/')), warning }
}

// After a refusal because of dependencies: where the whole order is, and what can start instead.
function blockedHint(slug: string): string {
  const i = intentOf(slug)
  if (!i || i.sprint === null || !i.depends.length) return ''
  const next = chartState(i.sprint).state === 'approved' ? planRows(i.sprint).filter(r => r.status === 'ready') : []
  return `\nThe build order is in ${writePlan(i.sprint)}.${next.length ? ` Ready now: ${next.map(r => r.slug).join(', ')}.` : ''}`
}

function cmdActivate(args: Args): void {
  const slug = checkSlug(args.pos[0] ?? '')
  if (!exists(changeDir(slug))) fail(`no such change: ${slug}`)
  setActive(slug)
  out(`active change: ${slug}${intentOf(slug) ? `\n${settledLine(slug)}` : ''}`)
}

const notInitialised = (json: boolean): void => out(json ? JSON.stringify({ initialised: false }) : `rig not initialised here: run ${skillRef('init')}`)

function cmdStatus(args: Args): void {
  const json = Boolean(args.opt.json)
  if (args.opt.journey) {
    if (!exists(SDLC)) return notInitialised(json)
    const j = journey({ gates: loadConfig().registry.gates, tree: treeStamp() })
    return out(json ? JSON.stringify({ ...j, sensors: sensorStatus() }) : journeyText(j))
  }
  if (!exists(SDLC)) return notInitialised(json)
  const gates = loadConfig().registry.gates
  const tree = treeStamp()
  const active = activeSlug()
  const changes = listChanges().map(slug => { const s = status(slug, gates, tree); return { slug, type: changeType(slug), status: s, next: nextStep(slug, s) } })
    .filter(c => c.status !== 'shipped' || c.slug === active)
  if (json) return out(JSON.stringify({ initialised: true, active, changes, sensors: sensorStatus() }))
  if (!changes.length) return out(`no changes yet: start one with ${skillRef('start')} "<request>"`)
  out(changes.map(c => `${c.slug === active ? '▶' : ' '} ${c.slug.padEnd(28)} ${c.type.padEnd(8)} ${c.status.padEnd(8)} next: ${c.next}`).join('\n'))
}

// A standalone repo's /rig:approve and /rig:waive skills pass '$ARGUMENTS' as one quoted string, so the shell never globs it.
const words = (args: Args): string[] => (args.pos.length === 1 ? (args.pos[0] ?? '').trim().split(/\s+/) : args.pos)

// What the person can type when their /rig-<cmd> slash command is not listed (a session started before the harness was vendored).
const humanFallback = (cmd: string, usage: string): string => `! SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning ${path.relative(process.cwd(), process.argv[1] ?? 'sdlc.ts')} ${cmd} ${usage}`

// `approve <slug> --check`: the refusal the approval would give, without approving; needs no person.
function approveCheck(args: Args): void {
  const given = words(args)[0]
  if (CHART_RE.test(given ?? '')) fail('--check is for a change plan: use approve chart-N without --check')
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug || !exists(changeDir(slug))) fail('usage: approve <slug> --check')
  const refusal = approvalRefusal(slug)
  if (refusal) fail(refusal)
  out(`ok: ${slug} can be approved`)
}

function cmdApprove(args: Args): void {
  if (args.opt.check) return approveCheck(args)
  if (process.env.SDLC_HUMAN !== '1') fail(`approvals are human-only: the person runs ${skillRef('approve')} <slug>. If that command is not listed, restart Claude Code, or the person types: ${humanFallback('approve', '<slug>')}`, 3)
  const given = words(args)[0] // a second word (the old stage name) is ignored
  if (!given && args.opt.ask) return out(approveTarget())
  const chart = CHART_RE.exec(given ?? '')?.[1]
  if (chart) return approveChart(Number(chart), args)
  const prd = PRD_RE.exec(given ?? '')?.[1]
  if (prd) fail(`there is no separate PRD approval: ${skillRef('approve')} chart-${prd} covers prd.md, source.md and conversion.md with the rest of the chart. Run ${skillRef('chart')} ${prd} to its end, then approve chart-${prd}`)
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug || !exists(changeDir(slug))) fail('usage: approve <slug>')
  const refusal = approvalRefusal(slug)
  if (refusal) fail(refusal)
  if (approvalState(slug) === 'approved' && JSON.stringify(readApproval(slug)?.contracts ?? {}) === JSON.stringify(freezeRecord())) return out(`${slug} is already approved. Next: ${skillRef('build')} ${slug}`)
  const by = ownerOrFail(args, 'approvals')
  const a = writeApproval(slug, by)
  const n = Object.keys(a.contracts).length
  out(`approved ${slug} by ${by}: spec.md and plan.md${n ? `, ${n} contract file(s) frozen` : ''}. Next: ${skillRef('build')} ${slug}`)
  // Not a refusal: the person may know better. But two writers on one file is a merge conflict later, so say so now.
  const clash = conflictsFor(slug)
  if (clash.length) out(`warning: another in-flight plan names the same file(s): ${clash.map(o => `${o.file} (${o.changes.join(' and ')})`).join('; ')}. Land one first, or split the work.`)
}

// What a bare /rig:approve would approve, for the skill to confirm with the person: the active change, else the first sprint chart waiting.
function approveTarget(): string {
  const active = activeSlug()
  if (active && exists(changeDir(active)) && !isShipped(active)) return `ASK change ${active}`
  const chart = sprintsKnown().find(n => exists(prdPath(n)) && sprintIntents(n).length > 0 && chartState(n).state !== 'approved')
  return chart === undefined ? 'ASK none: no change is in flight and no chart is waiting' : `ASK chart-${chart}`
}

const needPrd = (n: number): void => { if (!exists(prdPath(n))) fail(`no PRD for sprint ${n}: write ${prdRel(n)} first`) }

function approveChart(n: number, args: Args): void {
  needPrd(n)
  const conversion = isConverted(n) ? conversionRefusal(n) : null
  if (conversion) fail(conversion)
  const block = chartFindings(n, true).filter(f => f.severity === 'block')
  if (block.length) fail(`chart-${n} has ${block.length} blocking finding(s); fix them, then approve:\n${block.map(f => `  [${f.rule}] ${f.message}`).join('\n')}`)
  if (chartState(n).state === 'approved') return out(`chart-${n} is already approved`)
  const open = chartOpenFindings(n)
  if (!open) fail(`chart-${n} has no chart-review.md: run ${skillRef('chart')} ${n} through its review step, then approve`)
  if (!open.length && !/^verdict:\s*pass\s*$/m.test(read(reviewPath(n)).split('\n')[0] ?? '') && !chartReview(n)?.length) fail(`chart-${n}'s chart-review.md says changes-needed but lists no finding rig can read: write each as a \`- \` line under \`## Findings\``)
  if (open.length) fail(`chart-${n} has ${open.length} review finding(s) not confirmed fixed:\n${open.map(f => `  ${f.n}. ${f.text}${f.status === 'claimed' ? ' (marked fixed, never confirmed)' : ''}`).join('\n')}\nFix them and re-run the chart's confirm pass, or waive one with ${skillRef('waive')} chart-${n} <finding number> <reason>`)
  // The reviewer's Deferred list is for the person to decide; approval is where it is seen (shop_app 2026-10-27: a whitespace-sku question sat there undecided).
  const deferred = (/^#{2,3}[ \t]+Deferred\b[^\n]*\n([\s\S]*?)(?=^#{2,3}[ \t]|(?![\s\S]))/m.exec(read(reviewPath(n)))?.[1] ?? '').replace(/^\s*\n/, '').split(/\n(?=[-*]\s)/).filter(c => /^[-*]\s/.test(c)).filter(c => !/→\s*(?:fixed|waived|dropped|carried|taken)\b/i.test(c)).map(c => c.replace(/^[-*]\s+/, '').replace(/\s*\n\s*/g, ' ').trim()).filter(c => c && !/^(none|nothing|no (items?|deferred|findings?)|no .*\b(found|noted|recorded)\b)\.?$/i.test(c))
  const by = ownerOrFail(args, 'approvals')
  writeChartApproval(n, by)
  // A sensors.json with edits of its own is not swept into the approval commit: the person commits it.
  const sensorsDirty = (git(['status', '--porcelain', '--', '.rig/sensors.json']) ?? '') !== ''
  const reg = registerContracts((exists(intentsDir(n)) ? fs.readdirSync(intentsDir(n)) : []).flatMap(f => { const i = parseIntent(f, read(path.join(intentsDir(n), f))); return [...i.contractFiles, ...i.exampleFiles] }))
  const registered = reg.added
  writePlan(n)
  const committed = commitApproval(n, registered.length > 0 && !sensorsDirty)
  const branch = git(['branch', '--show-current']) ?? ''
  const trunk = trunkName()
  const first = branch && !isTrunk(branch) ? `merge ${branch} into ${trunk} first, then start from ${trunk} with ` : 'engineers run `ready` to see which intents can start, then '
  out(`${registered.length ? `registered ${registered.length} contract file(s) in .rig/sensors.json: ${registered.join(', ')}${sensorsDirty ? ' (sensors.json had uncommitted edits: commit it yourself)' : ''}\n` : ''}${deferred.length ? `${deferred.length} deferred review item(s) nobody has decided (chart-review.md ## Deferred); decide each before or during the build:\n${deferred.map(d => `  - ${d}`).join('\n')}\n` : ''}${reg.warning ? `warning: declared contract files were not registered (${reg.warning}); add them to contracts.files\n` : ''}${committed === null ? `warning: the approval is kept but git refused to commit it: commit it before building, with git add ${approvalRel(n)} ${sprintRel(n)}/plan.md ${ARCH_REL} .rig/product/adr && git commit -m "chore: approve chart-${n}"\n` : ''}approved chart-${n} by ${by}: ${chartFiles(n).length} file(s). Next: ${first}${skillRef('start')} ${sprintRel(n)}/intents/<slug>.md`)
}

const approvalRel = (n: number): string => `${sprintRel(n)}/approval.json`
// The approval hashes the files `acceptAdrs` edited: they must land in the same commit as approval.json, or HEAD disagrees with the approval
// and CI sees the chart as stale (shop_app 2026-10-27, where approval.json rode into a feature commit alone). Never --no-verify.
// true: committed; false: nothing to commit (not a git repo / nothing dirty); null: git refused.
function commitApproval(n: number, sensors = false): boolean | null {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return false
  const want = [approvalRel(n), `${sprintRel(n)}/plan.md`, ARCH_REL, ...(sensors ? ['.rig/sensors.json'] : []), ...chartFiles(n)].filter((f, i, a) => a.indexOf(f) === i && exists(path.join(ROOT, f)))
  const dirty = dirtyFiles(want)
  if (!dirty.length) return false
  if (git(['add', '--', ...dirty]) === null) return null
  return git(['commit', '-q', '-m', `chore: approve chart-${n}`, '--', ...dirty]) === null ? null : true
}

function cmdChart(args: Args): void {
  const [sub, num] = args.pos
  if (sub === 'next') {
    const next = nextChart()
    return out(args.opt.json ? JSON.stringify(next) : `${next.sprint === null ? 'sprint: ask' : `sprint ${next.sprint}`}${next.prd ? ` ${next.prd}` : ''} (${next.why})${next.candidates.length > 1 ? `\n${next.candidates.map(c => `  sprint ${c.sprint}: ${c.prd}`).join('\n')}` : ''}`)
  }
  if ((sub !== 'check' && sub !== 'report' && sub !== 'plan') || !/^\d{1,4}$/.test(num ?? '')) fail('usage: chart next [--json] | chart (check [--cases] [--json] | report | plan [--print]) <sprint number>')
  const n = Number(num)
  needPrd(n)
  if (sub === 'plan') return out(args.opt.print ? sprintPlan(n) : `wrote ${writePlan(n)}`)
  if (sub === 'report') return out(chartReport(n))
  const found = chartFindings(n, Boolean(args.opt.cases))
  if (args.opt.json) return out(JSON.stringify(found))
  const block = found.filter(f => f.severity === 'block')
  out([...found.map(f => `[${f.rule}] ${f.severity === 'report' ? '(report) ' : ''}${f.message}`), `chart-${n}: ${block.length ? `${block.length} blocking finding(s)` : 'no blocking findings'}`].join('\n'))
}

// The PRD format for coding agents (spec 2026-10-26): `prd check <N>` says whether the sprint PRD is in rig's template.
function cmdPrd(args: Args): void {
  const [sub, num] = args.pos
  if (!['check', 'map', 'ledger', 'status'].includes(sub ?? '') || !/^\d{1,4}$/.test(num ?? '')) fail('usage: prd (check [--json] | map [--json] | ledger | status) <sprint number>')
  const n = Number(num)
  needPrd(n)
  if (sub === 'status') {
    if (!isConverted(n)) return out('not converted: prd.md is the person\'s own')
    const why = conversionRefusal(n)
    return out(why ? `converted, not ready: ${why}` : `converted: ready to decompose; ${skillRef('approve')} chart-${n} covers prd.md, source.md and conversion.md`)
  }
  if (sub === 'ledger') {
    const format = prdFormatProblems(read(prdPath(n)))
    if (format.length) fail(`prd.md is not in format, so no ledger can be generated: run \`prd check ${n}\``)
    fs.writeFileSync(ledgerPath(n), prdLedger(read(prdPath(n))))
    return out(`wrote ${sprintRel(n)}/requirements.md: ${parseLedger(read(ledgerPath(n))).length} row(s) from prd.md`)
  }
  if (sub === 'map' && !exists(sourcePath(n))) fail(`sprint ${n} has no source.md: nothing was converted`)
  const found = sub === 'map' ? conversionProblems({ source: read(sourcePath(n)), prd: read(prdPath(n)), map: exists(conversionPath(n)) ? read(conversionPath(n)) : null }) : prdFormatProblems(read(prdPath(n)))
  if (args.opt.json) return out(JSON.stringify(found))
  out([...found.map(f => `[${f.rule}] ${f.where}: ${f.message}`), `prd-${n}: ${found.length ? `${found.length} finding(s)${sub === 'check' ? '; convert it into templates/prd-format.md' : ''}` : sub === 'check' ? 'in format' : 'every sentence of source.md is mapped'}`].join('\n'))
}

const readyRow = (i: ReturnType<typeof readyIntents>[number]): string => `${i.slug.padEnd(28)} sprint ${i.sprint}  ${i.estimateDays ?? '?'} day(s)`

function cmdReady(args: Args): void {
  const ready = readyIntents()
  if (args.opt.json) return out(JSON.stringify(ready))
  out(ready.length ? ready.map(readyRow).join('\n') : 'no intents are ready')
}

// The opening of /rig:start: the branch warning and the intents ready to build, so the skill does not need the model to ask for them.
function cmdStartBrief(): void {
  const branch = git(['branch', '--show-current']) ?? ''
  const base = trunkName()
  const lines: string[] = []
  if (/^rig\/chart-\d+$/.test(branch)) lines.push(`WARNING: you are on the chart branch ${branch}. Merge it into ${base} first and start the change from ${base}; a change built on an unmerged chart branch ships the chart with it (shop_app 2026-10-27: sdlc/cart-core sat on rig/chart-1).`)
  else if (branch && branch !== base) lines.push(`WARNING: you are on branch ${branch}, not ${base}. The previous change may not be merged yet; a new change starts from this branch.`)
  const sp = superpowersWarning()
  if (sp) lines.push(sp)
  const ready = readyIntents()
  const plans = sprintsKnown().filter(n => exists(prdPath(n)) && planRows(n).some(r => r.status !== 'done')).map(n => writePlan(n))
  if (plans.length) lines.push(`build order (waves and dependency graph): ${plans.join(', ')}`)
  lines.push(ready.length ? `ready intents:\n${ready.map(i => `  ${readyRow(i)}`).join('\n')}` : 'no intents are ready')
  out(lines.join('\n'))
}

// ---------- main ----------

// `run` takes its command after `--`, as one quoted argument: sdlc.ts run [--slug s] [--expect-fail] -- "<test command>"
function cmdRun(): void {
  const argv = process.argv.slice(3)
  const dash = argv.indexOf('--')
  if (dash < 0 || dash === argv.length - 1) fail('usage: run [--slug s] [--expect-fail] -- "<command>"')
  const head = parseArgs(argv.slice(0, dash))
  const cmd = argv.slice(dash + 1).join(' ')
  const given = optString(head, 'slug')
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail(`no such change: run ${skillRef('start')} first, or pass an existing --slug`)
  const expectFail = Boolean(head.opt['expect-fail'])
  const before = treeStamp()
  const row = runCommand(cmd)
  const tree = treeStamp() === before ? before : null
  const stamped = tree ? { ...row, tree } : row
  recordRun(slug, expectFail ? { ...stamped, expectFail: true } : stamped)
  if (row.tail) out(row.tail)
  out(`sdlc run: exit ${row.exit}${row.timedOut ? ' (timed out)' : ''} in ${row.ms} ms, recorded in ${slug}/evidence/runs.jsonl`)
  process.exitCode = expectFail ? (row.exit !== 0 ? 0 : 1) : row.exit
}

function cmdDiff(args: Args): void {
  const base = optString(args, 'base')
  if (!base && !args.opt.turn) fail('usage: diff (--turn | --base <ref>) [--json]')
  const snap = base ? null : readBaseline()
  if (!base && !snap) return out('no turn baseline yet (run a prompt first)')
  const diffs = base ? branchDiff(git(['merge-base', 'HEAD', base]) ?? base) : turnDiff(snap as Snapshot)
  if (args.opt.json) return out(JSON.stringify(diffs))
  out(diffs.map(d => `${d.status} ${d.file} (+${d.added.length} -${d.removed.length})`).join('\n') || 'no changes')
}

function cmdWaive(args: Args): void {
  if (process.env.SDLC_HUMAN !== '1') fail(`waivers are human-only: the person runs ${skillRef('waive')} <sensor> <file|*> <reason>. If that command is not listed, restart Claude Code, or the person types: ${humanFallback('waive', "<sensor> <file|*> '<reason>'")}`, 3)
  const chart = CHART_RE.exec(words(args)[0] ?? '')?.[1]
  if (chart) return waiveChart(Number(chart), args)
  const [sensor, file, ...reason] = words(args)
  const given = optString(args, 'slug')
  const slug = given ? checkSlug(given) : activeSlug()
  if (!sensor || !file || !reason.length || !slug) fail('usage: waive <sensor> <file|*> <reason...>  (needs an active change)')
  const commandIds = loadConfig().registry.sensors.filter(s => s.cmd).map(s => s.id)
  if (!SENSOR_NAMES.includes(sensor) && !commandIds.includes(sensor)) fail(`unknown sensor "${sensor}"; known: ${[...SENSOR_NAMES, ...commandIds].join(', ')}`)
  const by = ownerOrFail(args, 'waivers')
  const days = optString(args, 'days') === undefined ? 30 : Number(optString(args, 'days'))
  if (!Number.isInteger(days) || days < 1 || days > MAX_WAIVER_DAYS) fail(`--days must be a whole number from 1 to ${MAX_WAIVER_DAYS}: a waiver ends, and is renewed by waiving again`)
  const row: Waiver = { slug, sensor, file, reason: reason.join(' '), by, at: now(), expires: new Date(Date.now() + days * 86_400_000).toISOString() }
  fs.appendFileSync(WAIVERS, JSON.stringify(row) + '\n')
  out(`waived ${sensor} for ${file} in ${slug}: ${row.reason} (by ${by}, expires in ${days} day${days === 1 ? '' : 's'})`)
}

// A person accepts a chart review finding as it stands: no active change and no expiry, since it is an approval decision.
function waiveChart(n: number, args: Args): void {
  const [, k, ...reason] = words(args)
  if (!/^\d{1,3}$/.test(k ?? '') || !reason.length) fail(`usage: waive chart-${n} <finding number> <reason...>`)
  const f = chartReview(n)?.find(x => x.n === Number(k))
  if (!f) fail(`chart-${n} has no review finding ${k}${chartReview(n) ? '' : ' (no chart-review.md)'}`)
  const by = ownerOrFail(args, 'waivers')
  waiveChartFinding(n, f, by, reason.join(' '))
  out(`waived chart-${n} finding ${f.n}: ${reason.join(' ')} (by ${by})`)
}


function sensorStatus(): { blocks: number; warns: number; bySensor: Record<string, number>; unresolved: number; knownRed: number; waivers: number; inert: Inert[]; layers: string } | null {
  if (!exists(SDLC)) return null
  const last = readGate().last
  const slug = activeSlug()
  const { registry, rules } = loadConfig()
  return {
    blocks: last?.blocks ?? 0, warns: last?.warns ?? 0, bySensor: last?.bySensor ?? {}, unresolved: readUnresolved().length,
    knownRed: registry.knownRed.length, inert: inertSensors(registry, rules.length, draftApps()), layers: layerStateText(layerState()),
    waivers: readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug).length,
  }
}

function cmdSensors(): void {
  const s = sensorStatus()
  if (!s) return out('sdlc not initialised here')
  const { registry } = loadConfig()
  const slug = activeSlug()
  const unresolved = readUnresolved()
  const waivers = readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug)
  out([
    `last gate: ${s.blocks} block(s), ${s.warns} warning(s)${Object.keys(s.bySensor).length ? ' · ' + Object.entries(s.bySensor).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`,
    unresolved.length ? `unresolved:\n${formatFindings(unresolved)}` : 'unresolved: none',
    ...(s.inert.length ? [`not configured (passing checks nothing): ${s.inert.map(i => `${i.id} (${i.reason})`).join('; ')}`] : []),
    `layers: ${s.layers}`,
    `journeys: ${appStates().map(a => `${a.name} ${a.state}`).join(', ') || 'none'}`,
    `scope: ${slug && intentScope(slug) ? `${slug} is checked against ${intentScope(slug)?.scope.join(', ')}` : 'not checked (the active change has no scope: in its product intent)'}`,
    `ratchets: ${Object.entries(registry.ratchets ?? {}).map(([k, v]) => `${k} ${v}${registry.sensors.some(x => x.id === k && x.ratchet) ? '' : ' (no sensor ratchets it now)'}`).join(', ') || 'none'}`,
    `known red: ${registry.knownRed.join(', ') || 'none'}`,
    `waivers (${slug ?? 'no change'}): ${waivers.map(w => `${w.sensor} ${w.file} ${w.reason} (by ${!w.by || w.by === 'unknown' ? 'no owner' : w.by}, ${Number.isFinite(ageDays(w.at)) ? `${ageDays(w.at)}d` : 'age unknown'}, ${expiryText(w)}${ageDays(w.at) > STALE_WAIVER_DAYS ? ', stale: review it' : ''})`).join('; ') || 'none'}`,
  ].join('\n'))
}

// A starting policy skill for design and review to apply; only the person-run init writes it, and never over an existing one.
function scaffoldPolicy(): string {
  const rel = '.claude/skills/policy-security/SKILL.md'
  const src = path.join(PLUGIN_ROOT, 'templates', 'policy-security.md')
  if (exists(path.join(ROOT, rel)) || !exists(src)) return ''
  fs.mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true })
  const me = whoami()
  const text = read(src)
  fs.writeFileSync(path.join(ROOT, rel), me ? text.replace(/^owner: <[^>\n]*>$/m, `owner: ${me}`) : text)
  sanctionWrites([rel])
  return `wrote ${rel}: ${me ? `owner is ${me}; change it if someone else owns the policy, and set its source` : 'set its owner and source'}`
}

const COMMANDS: Record<string, (args: Args) => void> = {
  stamp: () => out(treeStamp() ?? 'none'),
  init: args => { const up = upgradePointer(); if (up) return out(up); cmdInit(args); if (args.opt.full) { const note = scaffoldPolicy(); if (note) out(note) } },
  new: cmdNew,
  activate: cmdActivate,
  status: cmdStatus,
  approve: cmdApprove,
  chart: cmdChart,
  prd: cmdPrd,
  ready: cmdReady,
  'start-brief': () => cmdStartBrief(),
  superpowers: () => out(superpowersWarning() || 'superpowers: ok'),
  pr: cmdPr, carry: cmdCarry,
  run: () => cmdRun(),
  verify: cmdVerify,
  hook: cmdHook,
  diff: cmdDiff,
  baseline: () => cmdBaseline(),
  check: args => (args.opt.at === 'push' ? cmdCheckPush(args) : cmdCheck(args)),
  'check-file': cmdCheckFile,
  sync: cmdSync,
  vendor: cmdVendor,
  upgrade: cmdUpgrade,
  hooks: cmdHooks,
  waive: cmdWaive,
  sensors: () => cmdSensors(),
  wiki: args => cmdWiki(args),
  learn: args => cmdLearn(args),
  report: cmdReport,
  arch: cmdArch,
  queue: cmdQueue,
  app: cmdApp,
  slice: cmdSlice,
  maintain: cmdMaintain,
  readiness: cmdReadiness,
  autonomy: cmdAutonomy,
  risk: cmdRisk,
  weight: cmdWeight,
}

const [command = '', ...rest] = process.argv.slice(2)
const run = COMMANDS[command]
if (!run) fail(`usage: sdlc.ts <${Object.keys(COMMANDS).join('|')}> ...`)
try {
  run(parseArgs(rest))
} catch (err) {
  // Hooks must never wedge a session: a crashing hook reports and lets the action through.
  const message = err instanceof Error ? err.message : String(err)
  if (command === 'hook') process.stderr.write(`${SOFT_HOOK_FAILURE}: ${message}\n`)
  else if (command === 'check' && /^(?:commit|push)$/.test(String(parseArgs(rest).opt.at))) {
    // Inside a git hook (spec §2): a broken checker must not wedge the repo; CI judges the result.
    process.stderr.write(`rig: the checker crashed (${message}); allowing — CI still checks\n`)
    process.exitCode = 0
  } else if (command === 'check') fail(`sdlc check crashed (fails closed): ${message}`)
  else fail(err instanceof Error ? err.stack ?? message : message)
}
