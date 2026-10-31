// `verify` (behavioural harness spec 2026-10-16 §8): every commit and ci sensor, the contracts (validate first) and the
// change's own verdicts on the branch diff. verify.json records the tree it judged, so pr can tell a stale verification.
import path from 'node:path'
import { CHANGES, BUDGET_MS, exists, out, fail, now, defaultBase, checkSlug, optString, type Args } from './core.ts'
import { loadConfig, runChecks } from './check.ts'
import { branchDiff, showAt } from './diffs.ts'
import { treeStamp } from './stamp.ts'
import { formatFindings } from './model.ts'
import { activeSlug, writeVerify } from './lifecycle.ts'

export function cmdVerify(args: Args): void {
  const given = args.pos[0]
  const slug = given ? checkSlug(given) : activeSlug()
  if (!slug || !exists(path.join(CHANGES, slug))) fail('usage: verify [<slug>] (no active change)')
  const { registry: config, rules, errors } = loadConfig()
  const base = defaultBase(), ref = base ?? 'HEAD', before = treeStamp(), from = now()
  const budgetMs = Number(optString(args, 'budget-ms') ?? BUDGET_MS.ship)
  const r = runChecks({ point: 'ship', diffs: branchDiff(ref), config, rules, slugs: [slug], commands: 'full', budgetMs, before: f => showAt(ref, f) ?? '', base, ratchet: false, gates: config.gates })
  const blocks = [...errors.map(e => `config: ${e}`), ...r.blocks.map(f => `${f.sensor}${f.file ? ` ${f.file}` : ''}: ${(f.message.split('\n')[0] ?? '').slice(0, 200)}`)]
  writeVerify(slug, { at: now(), from, tree: treeStamp() === before ? before : null, base, pass: !blocks.length, blocks })
  out([formatFindings(r.findings) || 'verify: every commit and ci sensor passed', `verify.json: ${blocks.length ? `fail (${blocks.length} block(s))` : 'pass'}`].join('\n'))
  process.exitCode = blocks.length ? 1 : 0
}
