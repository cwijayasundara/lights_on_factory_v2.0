// The Stop decision: may the build session end? Pure: everything it needs is in ctx.
import { nextTask, skippedTasks } from './plan.mjs'

const block = reason => ({ kind: 'block', reason })
const stall = reason => ({ kind: 'allow', header: 'STALLED', reason })

export function decide(ctx) {
  const tasks = ctx.plan?.ok ? ctx.plan.tasks : []
  const stalled = guard(ctx, tasks)
  if (stalled) return stalled
  if (ctx.protectedDiff) return block(`restore the protected files; they must match the install commit:\n${ctx.protectedDiff}`)
  if (ctx.weakened) return block(`restore the assertions removed or loosened in existing tests; add new tests instead:\n${ctx.weakened}`)
  if (!ctx.plan) return block('write PLAN.md from SPEC.md')
  if (!ctx.plan.ok) return block(`fix PLAN.md: ${ctx.plan.errors.map(e => `line ${e.line}: ${e.message}`).join('; ')}`)
  if (!ctx.lock.ok) return block(`restore the plan: ${ctx.lock.problems.join('; ')}`)
  const last = tasks.at(-1)
  if (!last || last.verify !== ctx.demoRun) return block(`the last task must verify with: ${ctx.demoRun}`)
  const next = nextTask(tasks)
  if (next) return block(`next task: ${next.n}. ${next.outcome} (verify: ${next.verify})`)

  const skipped = new Set(skippedTasks(tasks).map(task => task.n))
  const partial = skipped.size > 0 || tasks.some(task => task.status === 'blocked')
  const header = partial ? 'PARTIAL' : ctx.acceptedMutants > 0 ? `COMPLETE (${ctx.acceptedMutants} accepted mutants)` : 'COMPLETE'
  // Cheap checks first: the full gates run once, on the final stop attempt.
  if (ctx.uncommitted) return block(`commit and push your work:\n${ctx.uncommitted}`)
  const { exists, fresh } = ctx.report
  if (!exists || !fresh || ctx.report.header !== header) return block(`write BUILD-REPORT.md with first line "${header}"`)
  const notDone = ctx.checkDone()
  if (notDone) return block(`${notDone}; reopen it or fix it`)
  const demoMissing = last.status === 'blocked' || skipped.has(last.n)
  const failed = ctx.runGates({ skipDemo: partial && demoMissing }).find(gate => !gate.ok)
  if (failed) return block(`gate ${failed.name} failed; fix it and keep going:\n${failed.tail}`)
  return { kind: 'allow', header }
}

// Maintain phase: the operator is at the keyboard. No clock, no plan, no report; protected files and fast gates only.
export function decideMaintain(ctx) {
  if (ctx.protectedDiff) return block(`restore the protected files; they must match the install commit:\n${ctx.protectedDiff}`)
  const failed = ctx.runGates().find(gate => !gate.ok)
  if (failed) return block(`gate ${failed.name} failed; fix it and keep going:\n${failed.tail}`)
  return { kind: 'allow', header: 'MAINTAIN' }
}

function guard(ctx, tasks) {
  const { limits } = ctx
  if (ctx.guard.noProgressBlocks >= limits.maxNoProgressBlocks) {
    return stall(`no progress in ${ctx.guard.noProgressBlocks} consecutive blocks`)
  }
  if (ctx.guard.elapsedHours >= limits.wallClockHours) return stall(`wall clock budget of ${limits.wallClockHours} hours used`)
  const blocked = tasks.filter(task => task.status === 'blocked').length
  if (blocked > limits.maxBlockedTasks) return stall(`${blocked} tasks blocked, more than the limit of ${limits.maxBlockedTasks}`)
  return null
}
