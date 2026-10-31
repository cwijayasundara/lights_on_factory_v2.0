// `pr` (behavioural harness spec 2026-10-16 §8): a change whose plan a person approved and whose verify.json is fresh for
// this tree is committed on sdlc/<slug>, pushed, and gets a PR, or stays local-only without a remote.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, CHANGES, WAIVERS, waiverLive, exists, isTrunk, trunkName, read, readJsonl, out, fail, git, checkSlug, optString, ensureGitignore, dirtyFiles, skillRef, defaultBase, type Args, type Waiver } from './core.ts'
import { frozenFindings, frozenFor } from './contracts.ts'
import { loadConfig } from './check.ts'
import { gh as ghRun, section, isTest } from './model.ts'
import type { RunRow } from './runs.ts'
import { treeStamp } from './stamp.ts'
import { activeSlug, setActive, approvalState, verifyFresh, isShipped, changeDir } from './lifecycle.ts'
import { prBody } from './prbody.ts'
import { riskOf } from './risk.ts'
import { parseAccess } from './chartcheck.ts'
import { branchDiff } from './diffs.ts'
import { archPath } from './product.ts'
import { intentOf, intentsOf, writePlan, readyAfter } from './chart.ts'
import { isHarnessPath } from './vendor.ts'
import { untestedAcs } from './actrace.ts'
import { routeReview, recordAdditions } from './carry.ts'

const ghLast = (text: string): string => text.trim().split('\n').at(-1) ?? ''
const URL_RE = /^https?:\/\//

function openPr(slug: string, branch: string, title: string): string | null {
  const body = path.join(CHANGES, slug, 'pr-body.md')
  const gh = (argv: string[]): string => ghRun(argv, ROOT)
  try { gh(['pr', 'create', '--title', title, '--body-file', body]) } catch (e) {
    const x = e as { stdout?: unknown; stderr?: unknown }
    // The PR already exists (a rerun, or opened by hand): report its url.
    if (!/already exists/i.test(`${String(x.stdout ?? '')}${String(x.stderr ?? '')}`)) return null
  }
  try { const url = ghLast(gh(['pr', 'view', branch, '--json', 'url', '-q', '.url'])); return URL_RE.test(url) ? url : null } catch { return null }
}

// The files a change's commit carries: its own folder, source outside .rig/, and the harness files a change may touch.
// Another change's folder never rides along, so its own gate cannot fail this PR. A sprint chart approval does, so CI sees it.
const SHARED = ['.rig/waivers.jsonl', '.rig/autonomy.json', '.rig/.gitignore', '.rig/sensors.json', '.rig/rules.json', '.rig/product/brief.md', '.rig/wiki.json']
const SHARED_DIRS = ['.rig/guides/', '.rig/wiki/']
// Only the sprint approval rides along by pattern; the plan, the carried files, the backlog and the additions ship when this run wrote them.
const SHARED_RE = /^\.rig\/product\/sprints\/sprint-\d+\/approval\.json$/
const changeFiles = (slug: string, wrote: string[]): string[] => dirtyFiles().filter(f => ships(slug)(f) || wrote.includes(f))

// What a PR for this change carries under .rig/: its own record and the shared files; the rest of .rig/ stays local.
// A vendored harness file never rides along: a rig upgrade left uncommitted ended up in a feature commit (shop_app 2026-10-27).
// pr-outline.md is embedded in pr-body.md, which ships; storing both kept the text twice.
const ships = (slug: string) => (f: string): boolean => !isHarnessPath(f) && !f.endsWith(`/${slug}/pr-outline.md`) && (!f.startsWith('.rig/') || f.startsWith(`.rig/changes/${slug}/`) || SHARED_DIRS.some(d => f.startsWith(d)) || SHARED_RE.test(f) || SHARED.includes(f))

export function cmdPr(args: Args): void {
  const given = args.pos[0]
  const slug = given ? checkSlug(given) : activeSlug()
  const message = optString(args, 'message')
  if (!slug || !message) fail('usage: pr [<slug>] --message "<type(scope): summary>"')
  if (!exists(path.join(CHANGES, slug))) fail(`no such change: ${slug}`)
  const followUp = exists(path.join(CHANGES, slug, 'pr.md'))
  const branch = `sdlc/${slug}`
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
  if (head !== branch) {
    if (followUp) fail(`not pushing: ${slug} already has a PR on ${branch}; check it out first (HEAD is ${head})`)
    if (!isTrunk(head)) fail(`not shipping: HEAD is ${head}; a change ships from the trunk or from ${branch}, never on top of another branch`)
  }
  const gates = loadConfig().registry.gates
  if (gates.plan && approvalState(slug) !== 'approved') fail(`not shipping: ${slug}'s plan is not approved (a person runs ${skillRef('approve')} ${slug})`)
  if (!verifyFresh(slug, treeStamp())) fail(`not shipping: verify.json is missing, failing or from another tree; run ${skillRef('test')} ${slug}`)
  // Contract files can sit under .rig/, which the tree stamp leaves out: judge the freeze here, with the person's waivers.
  const waived = readJsonl<Waiver>(WAIVERS).filter(w => w.slug === slug && w.sensor === 'harness-tamper' && waiverLive(w))
  const frozen = frozenFindings([slug], Object.keys(frozenFor(slug)), f => read(path.join(ROOT, f))).filter(f => !waived.some(w => w.file === '*' || w.file === f.file))
  if (frozen.length) fail(`not shipping: ${frozen.map(f => f.message).join('; ')}. Revert it, or a person re-approves or waives it`)
  // A review fix wave that changed behaviour amends the spec, but spec.md is hashed into the approval: the amendment goes in amendments.md (or "none").
  if (/^\s*[-*] .*→ fixed\b/m.test(section(read(path.join(CHANGES, slug, 'review.md')), 'Findings')) && !exists(path.join(CHANGES, slug, 'amendments.md'))) fail(`not shipping: review.md has fixed findings but ${slug} has no amendments.md; write it: one "- A<n> (B<n>): what now behaves differently, and why" line per fix that changed documented behaviour, or "none" under ## Amendments`)
  const missing = untestedAcs(slug, loadConfig().registry.paths)
  if (missing.length) fail(`not shipping: no test names these acceptance criteria (name each test after its AC, e.g. test_ac_1_2_..., or put the id in the test title):\n${missing.map(m => `  ${m}`).join('\n')}`)
  if (head !== branch) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) !== null) fail(`not shipping: branch ${branch} already exists; check it out first`)
    if (git(['checkout', '-b', branch]) === null) fail(`could not create branch ${branch}`)
  }
  const remote = git(['remote', 'get-url', 'origin']) !== null
  const title = (message.split('\n')[0] ?? slug).slice(0, 200)
  if (!followUp) {
    fs.writeFileSync(path.join(CHANGES, slug, 'pr.md'), `---\nstate: ${remote ? 'open' : 'local-only'}\nbranch: ${branch}\n---\n${title}\n`)
    ensureGitignore()
    const c = (name: string): string => read(path.join(CHANGES, slug, name))
    let verify: (Parameters<typeof prBody>[0]['verify'] & { base?: string }) | null = null
    try { verify = JSON.parse(c('verify.json')) } catch { /* no verify.json: the body says so */ }
    const diff = branchDiff(verify?.base ?? defaultBase() ?? 'HEAD'), { registry } = loadConfig()
    const tests = diff.filter(d => d.status !== 'D' && !d.binary && isTest(d.file, registry.paths)).map(d => read(path.join(ROOT, d.file))).join('\n')
    fs.writeFileSync(path.join(CHANGES, slug, 'pr-body.md'), prBody({ intent: c('intent.md'), spec: c('spec.md'), plan: c('plan.md'), verify, outline: c('pr-outline.md'), review: c('review.md'), amendments: c('amendments.md'), runs: readJsonl<RunRow>(path.join(CHANGES, slug, 'evidence', 'runs.jsonl')), tests, risk: riskOf(diff.filter(d => ships(slug)(d.file)), [slug], registry, parseAccess(read(archPath)), false) }))
  }
  // The merge ships this change: write the sprint plan as it will read then, so nothing regenerates dirty afterwards.
  // Another change of the sprint in flight would find the plan changed under it, so the plan waits for the last one.
  // A change whose PR is open (a local pr.md) counts as shipped too, so the last PR of a sprint still writes the plan.
  const sprint = intentOf(slug)?.sprint, others = typeof sprint === 'number' ? intentsOf(sprint).filter(i => i.slug !== slug && exists(changeDir(i.slug)) && !isShipped(i.slug)) : []
  const prOpen = others.filter(i => exists(path.join(changeDir(i.slug), 'pr.md'))).map(i => i.slug), busy = others.length > prOpen.length
  const wrote = typeof sprint === 'number' && !busy ? [writePlan(sprint, [slug, ...prOpen])] : []
  // Review items and additions are written into the carried files, the backlog and the intent before the commit; the PR carries just those.
  wrote.push(...routeReview(slug).files, ...recordAdditions(slug).files)
  const files = changeFiles(slug, wrote)
  const left = dirtyFiles().filter(isHarnessPath)
  if (left.length) out(`pr ${slug}: left out ${left.length} vendored harness file(s) (${left.slice(0, 3).join(', ')}${left.length > 3 ? ', ...' : ''}); they look like an uncommitted ${skillRef('upgrade')}: commit them on their own branch`)
  if (!files.length) return out(followUp ? `${slug} already has a PR (.rig/changes/${slug}/pr.md); nothing new to commit` : 'not shipping: nothing to commit')
  // A first run that fails before the PR is open must leave no pr.md (and no commit), or a rerun reads it as a follow-up and never opens the PR.
  const undo = (committed: boolean): void => { if (followUp) return; if (committed) git(['reset', '-q', 'HEAD~1']); fs.rmSync(path.join(CHANGES, slug, 'pr.md'), { force: true }); fs.rmSync(path.join(CHANGES, slug, 'pr-body.md'), { force: true }) }
  if (git(['add', '--', ...files]) === null) { undo(false); fail('git add failed') }
  // verify judged this tree with waivers applied: the git hooks would only run the same checks again.
  if (git(['commit', '-q', '--no-verify', '-m', message]) === null) { undo(false); fail('git commit failed') }
  // The review's fix wave re-activates the change so the hooks guard it; its follow-up ends it. Another active change stays.
  if (!followUp || activeSlug() === slug) setActive(null)
  const next = readyAfter(slug)
  if (!remote) return out(`pr ${slug}: committed on ${branch}${followUp ? ' (follow-up)' : ''}; no origin remote, local only. Next: merge ${branch} into ${trunkName()}${next[0] ? `, then ${next[0]}` : ''}`)
  const retry = `gh pr create --title ${JSON.stringify(title)} --body-file .rig/changes/${slug}/pr-body.md`
  if (git(['push', '--no-verify', '-u', 'origin', branch]) === null) { undo(true); fail(`git push failed; ${followUp ? `the follow-up is committed on ${branch}: push it` : 'nothing was kept: fix the remote and rerun pr'}`) }
  if (followUp) return out(`pr ${slug}: follow-up pushed to ${branch}`)
  const url = openPr(slug, branch, title)
  if (!url) fail(`pushed ${branch} but gh pr create printed no PR url: run ${retry}`)
  out(`pr ${slug}: ${url}`)
}
