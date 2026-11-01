---
name: build-discipline
description: How to build this project unattended from SPEC.md to done. Invoke it at the start of a build session and again after any context compaction.
---

# Build discipline

You are building this project with nobody watching. SPEC.md is the approved spec. The Stop hook decides when you may stop; you cannot talk your way past it. Work like this until it lets you go.

## Plan first

If PLAN.md does not exist, write it from SPEC.md, then commit and push it before any code. That first committed plan is locked.

- One task per small, verifiable unit, in build order. Aim for 8 to 15 tasks.
- Format, exactly:

```
- [ ] 1. <one-line outcome>
  verify: <shell command that exits 0 only when the outcome holds>
  after: <comma list of task numbers it needs, optional>
```

- Mark a finished task `[x]` and add `done: <short sha of the commit that built it>`.
- Mark a stuck task `[!]` and add `blocked: BLOCKED.md#task-<n>`.
- The last task's `verify:` is the demo command from `.factory/build.json` (`demo.run`).
- After the first commit you may append tasks, add `after:` entries, and change marks. Never remove a task or change its outcome or `verify:` line. The hook rejects that.

## Make it work

- Get the data shape right before the logic.
- Write the failing test first. Run it and see it fail for the reason you expect.
- Make the smallest change that passes. One decision lives in one place.
- Check outside data where it enters; trust it inside. Keep business logic in pure functions.
- Fix root causes. A guard that hides a crash is not a fix.
- Take complexity out before adding more.

## Prove it

- A test calls the code the way its user does and checks what that user would see. If it would still pass with every function returning nothing, delete it.
- Never skip, delete or weaken a test to get green.
- After each task, run its `verify:` command, then every gate in `.factory/build.json` in order. Use `python3 .factory/gates/mutate.py --changed` while building; the Stop hook runs the full mutation gate at the end.
- When a gate fails, fix the code. Split or test a function above CRAP 10. Remove duplication. Kill surviving mutants and cover uncovered ones, or delete dead code.
- Only a genuinely equivalent mutant may be accepted. Add it to `.factory/accepted-mutants.md` as `- <file>:<line> <from> -> <to> — <why no test can tell them apart>`. At most 5. Each one shows on the report's first line.

## Drive to done

Adapted from pstack's autonomous-run playbook (MIT, see NOTICE.md in the factory).

- Done is fixed before you start: every task `[x]`, every gate green, the demo working. Never loosen it to declare victory.
- Each iteration makes the smallest change the evidence justifies, verifies it, and commits it. Revert what did not help.
- A plateau is not a stop. Try a different approach.
- Problems you meet on the way are yours: a flaky test, a broken tool, a missing dev dependency. Fix them.
- Do not edit `.claude/`, `.factory/build.json`, `.factory/gates/` or SPEC.md. They are protected and the hook checks them.

## Never ask

Nobody will answer. Never ask the operator a question and never wait for input.

- **When SPEC.md is silent,** pick the simplest choice that fits it, then record it in DECISIONS.md and keep going:

```
- <decision> — <why> — <where in the code>
```

- **When a task truly cannot be finished,** after at least two different approaches, write it to BLOCKED.md under `## Task <n>` with what you tried, why it failed, and what you would try next. Mark it `[!]` and continue with the next task that does not need it. More than 2 blocked tasks ends the run as STALLED.

## Pause and pick up

The session can end or compact at any time. Keep everything that matters on disk and committed.

- On start or resume, read PLAN.md, DECISIONS.md, BLOCKED.md and `git log --oneline -20`. Continue from the next open task. Never redo work that is already committed.

## Commit

- One commit per task, plus small fix-up commits when needed. The message says why, what changed, and how you proved it (the verify command and gate results).
- Record the `[x]` mark and `done:` sha in the next commit.
- Push after every commit: `git push origin main`. Never force-push, rebase or amend.

## Finish

When every task is `[x]` or `[!]` and every gate passes, write BUILD-REPORT.md, commit it and push. Its first line is exactly the header the Stop hook asks for: `COMPLETE`, `COMPLETE (N accepted mutants)` or `PARTIAL`. Then, in this order:

1. **Tests:** the exact commands you ran and their results, coverage, and each gate against its threshold.
2. **Demo:** the command to paste, and the output it printed.
3. **Decisions:** the number of entries in DECISIONS.md, a link to it, a link to BLOCKED.md, and every accepted mutant.
4. **Tail:** tasks done out of total, commits, and wall time.

If the Stop hook blocks you, do what its reason says and continue. If a loop guard stops the run, it writes STALLED at the top of the report itself.
