// Git hooks: the same checker as Stop, ship and CI, run at `git commit` and `git push`, so any editor, agent or person is judged.
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, SDLC, TRUNKS, SENSORS_JSON, BUDGET_MS, git, exists, out, fail, type Args } from './core.ts'
import { loadConfig, runChecks, slugsIn } from './check.ts'
import { rangeDiff, showAt } from './diffs.ts'
import { activeSlug, verifyFresh } from './lifecycle.ts'
import { treeStamp } from './stamp.ts'
import { formatFindings, warnLines, type Finding } from './model.ts'

const HOOKS_DIR = '.rig/githooks'
const NAMES = ['pre-commit', 'pre-push'] as const
const AT = { 'pre-commit': 'commit', 'pre-push': 'push' } as const

// A hook that cannot run warns and lets git go on: CI is the floor, and a broken hook must not wedge a repo.
const script = (name: (typeof NAMES)[number]): string => [
  '#!/bin/sh',
  '# rig: runs the same checker as Stop, ship and CI.',
  'cd "$(git rev-parse --show-toplevel)" || exit 0',
  `if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then`,
  `  echo "rig: Node >= 22.18 not found, skipping ${name} (CI still checks)" >&2; exit 0`,
  'fi',
  `[ -f .rig/bin/sdlc.ts ] || { echo "rig: .rig/bin/sdlc.ts is missing, skipping ${name} (run vendor, then hooks install)" >&2; exit 0; }`,
  `exec node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts check --at ${AT[name]}`,
  '',
].join('\n')

export const HOOK_SCRIPTS = (): [rel: string, text: string][] => NAMES.map(name => [`${HOOKS_DIR}/${name}`, script(name)])

function writeHookScripts(written: string[] = []): void {
  fs.mkdirSync(path.join(ROOT, HOOKS_DIR), { recursive: true })
  for (const [rel, text] of HOOK_SCRIPTS()) {
    const file = path.join(ROOT, rel)
    // Unchanged scripts are left alone, so a session start under the same plugin never dirties the tree.
    if (!exists(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text)
    if ((fs.statSync(file).mode & 0o777) !== 0o755) fs.chmodSync(file, 0o755)
    written.push(rel)
  }
}

type HooksState = 'installed' | 'missing' | 'other'
export function hooksState(): { state: HooksState; path: string } {
  // Any scope: a global or system hooksPath would otherwise be shadowed in silence. ./x and x/ are x.
  const p = git(['config', '--get', 'core.hooksPath']) ?? ''
  const norm = p.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  return { state: norm === HOOKS_DIR ? 'installed' : p === '' ? 'missing' : 'other', path: p }
}

export function installHooks(force = false): { ok: boolean; message: string } {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts'))) return { ok: false, message: 'git hooks run the vendored checker: run `vendor` (or `vendor --standalone`) first so .rig/bin/sdlc.ts exists' }
  // An older vendored checker does not know `check --at commit` and would refuse every commit.
  if (!exists(path.join(SDLC, 'bin', 'githooks.ts'))) return { ok: false, message: '.rig/bin is older than the git hooks (no githooks.ts): re-run `vendor` to update it, then hooks install' }
  writeHookScripts()
  const { state, path: current } = hooksState()
  if (state === 'other' && !force) {
    return { ok: false, message: `core.hooksPath is already ${current}, so it was left alone. Call rig from your existing hooks instead:\n  sh .rig/githooks/pre-commit\n  sh .rig/githooks/pre-push "$@"\nor re-run with --force to replace it.` }
  }
  if (git(['config', '--local', 'core.hooksPath', HOOKS_DIR]) === null) return { ok: false, message: 'could not set core.hooksPath in the local git config (is this a git repository with a writable .git/config?)' }
  git(['config', '--local', '--unset', 'rig.githooks']) // clears an earlier opt-out; a missing key is fine
  return { ok: true, message: `git hooks installed (core.hooksPath = ${HOOKS_DIR}): commit and push now run the rig checks` }
}

// Session start wires committed hooks in a fresh clone (core.hooksPath is local git config, so a clone never has it).
// `hooks uninstall` is the person's opt-out (rig.githooks = off): session start then stays silent.
export function sessionNote(): string {
  try {
    return wireAtSessionStart()
  } catch {
    return '' // a throw here must not drop the rest of the SessionStart context
  }
}

function wireAtSessionStart(): string {
  if (!exists(path.join(SDLC, 'bin', 'sdlc.ts')) || !exists(path.join(ROOT, HOOKS_DIR))) return ''
  if (git(['config', '--get', 'rig.githooks']) === 'off') return ''
  const { state, path: current } = hooksState()
  if (state === 'installed') return ''
  if (state === 'other') return `Git hooks: core.hooksPath is ${current}, so the rig commit and push checks are not wired. Do not change it yourself: ask the person to run \`node .rig/bin/sdlc.ts hooks install --force\` if they want rig's hooks.`
  const r = installHooks()
  return r.ok ? `Git hooks: installed the rig pre-commit and pre-push checks (core.hooksPath = ${HOOKS_DIR}). Opt out with: node .rig/bin/sdlc.ts hooks uninstall` : `Git hooks: ${r.message}`
}

function uninstallHooks(): string {
  git(['config', '--local', 'rig.githooks', 'off']) // session start will not wire them again
  if (hooksState().state !== 'installed') return 'rig git hooks are not installed (session start will not wire them; `hooks install` undoes this)'
  git(['config', '--local', '--unset', 'core.hooksPath'])
  return 'rig git hooks uninstalled (core.hooksPath unset); the scripts stay in .rig/githooks'
}

export function cmdHooks(args: Args): void {
  const sub = args.pos[0]
  if (sub === 'install') {
    const r = installHooks(Boolean(args.opt.force))
    if (!r.ok) fail(r.message)
    return out(r.message)
  }
  if (sub === 'uninstall') return out(uninstallHooks())
  if (sub === 'status') {
    const { state, path: p } = hooksState()
    return out(state === 'installed' ? `rig git hooks installed (${HOOKS_DIR})` : state === 'other' ? `rig git hooks not installed: core.hooksPath is ${p}` : 'rig git hooks not installed: run `sdlc.ts hooks install`')
  }
  out('usage: hooks install [--force] | uninstall | status')
}

const ZERO = /^0+$/
type PushRef = { localRef: string; localSha: string; remoteRef: string; remoteSha: string }

// git feeds pre-push one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
function parsePushRefs(stdin: string): PushRef[] {
  return stdin.split('\n').filter(l => l.trim()).map(l => {
    const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = l.trim().split(/\s+/)
    return { localRef, localSha, remoteRef, remoteSha }
  })
}

// The base CI would use (the merge-base with the trunk, for the pushed commit, not HEAD), so merging or rebasing on
// the trunk never counts the trunk's own work. A push to the trunk itself judges what the remote lacks.
function pushBase(r: PushRef): string | null {
  const trunk = TRUNKS.find(t => git(['rev-parse', '--verify', '--quiet', `${t}^{commit}`]))
  const mb = trunk ? git(['merge-base', r.localSha, trunk]) : null
  const tb = mb && mb !== r.localSha ? mb : null // already on the trunk: nothing of its own to compare
  const toTrunk = Boolean(trunk) && r.remoteRef === `refs/heads/${trunk?.replace('origin/', '')}`
  if (tb && !toTrunk) return tb
  const remote = ZERO.test(r.remoteSha) ? null : r.remoteSha
  return remote && git(['merge-base', '--is-ancestor', remote, r.localSha]) !== null ? remote : tb
}

const readStdin = (): string => { try { return fs.readFileSync(0, 'utf8') } catch { return '' } }
// Running out of budget is a warning at push: CI still runs the commands.
// Pre-push always runs, inside the commit-cadence budget (spec §3.1).
const soften = (f: Finding): Finding => (f.outOfTime ? { ...f, severity: 'warn' } : f)

export function cmdCheckPush(_args: Args): void {
  const { registry: config, rules, errors } = loadConfig()
  const raw = readStdin()
  const judged = (r: PushRef): boolean => !ZERO.test(r.localSha) && r.remoteRef.startsWith('refs/heads/')
  const all = raw.trim() ? parsePushRefs(raw) : [{ localRef: 'refs/heads/HEAD', localSha: git(['rev-parse', 'HEAD']) ?? '', remoteRef: 'refs/heads/HEAD', remoteSha: '0' }]
  const refs = all.filter(judged)
  if (!refs.length) return out('sdlc check push: nothing to judge (a delete or tag push)')
  const findings: Finding[] = errors.map(e => ({ sensor: 'config', severity: 'block', file: SENSORS_JSON, message: e, fix: 'fix the file' }))
  const notes = all.filter(r => !judged(r)).map(r => `${r.remoteRef}: skipped (a delete or tag)`)
  const head = git(['rev-parse', 'HEAD'])
  const drifted = refs.some(r => r.localSha !== head) || Boolean(git(['status', '--porcelain', '--untracked-files=no']))
  if (drifted) notes.push('note: the full commands and quality ratchet run against your working tree, not the pushed commits; changed-lines sensors skipped (CI runs them)')
  for (const r of refs) {
    const base = pushBase(r)
    if (!base || git(['cat-file', '-e', `${base}^{commit}`]) === null) { notes.push(`${r.remoteRef.replace('refs/heads/', '')}: no base to compare against, so CI judges it`); continue }
    const diffs = rangeDiff(base, r.localSha)
    if (!diffs.length) continue
    // A finished change is not active, but its branch carries its folder: judge the push as that change (its branch's first), as CI does.
    const owned = slugsIn(diffs).filter(s => exists(path.join(SDLC, 'changes', s)))
    const slug = activeSlug() ?? owned.find(s => r.remoteRef === `refs/heads/sdlc/${s}`) ?? owned[0] ?? null
    // A change verified on exactly this tree, pushed from a clean checkout of it, needs its full commands no second time.
    const covered = Boolean(slug) && r.localSha === head && !git(['status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).rig']) && verifyFresh(slug as string, treeStamp())
    const result = runChecks({
      point: 'ship', diffs, config, rules, slugs: [], commands: covered ? 'none' : 'full', budgetMs: BUDGET_MS.commit,
      before: f => showAt(base, f) ?? '', after: f => showAt(r.localSha, f) ?? '', base, ratchet: false, drifted,
    })
    findings.push(...result.findings.map(soften))
  }
  const blocks = findings.filter(f => f.severity === 'block')
  out([formatFindings(findings) || 'sdlc check push: pass', ...warnLines(findings), ...notes].join('\n'))
  process.exitCode = blocks.length ? 1 : 0
}
