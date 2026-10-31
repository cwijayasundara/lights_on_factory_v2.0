---
name: rig:build
description: Build an approved change test-first - one failing test per behaviour, then the code - on its own branch.
argument-hint: '[<slug>]'
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts *), Bash(git checkout*), Bash(git status*), Bash(git diff*), Read, Grep, Glob, Write, Edit, Agent
---
# Build a change

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`.

1. Run `S status --json`. The change (`$0` or the active one) must be at `build`. At `approve`, stop: a person approves first.
2. If HEAD is the trunk, run `git checkout -b sdlc/<slug>`.
3. Read `.rig/changes/<slug>/requirements.md` when it exists: the PRD's own words for this change; never edit it, and a test asserts each row's numbers and limits as written. For each behaviour in spec.md, in order:
   - Write the test that names its B-number, and name it after each acceptance criterion it proves: `test_ac_1_2_...`, or the id (`AC-1.2`) in the test title. `pr` refuses a change whose intent cites an AC that no test names.
   - A test implementing a test-plan case whose Data column names a file (`data/blank-sku.json`) loads that file from the sprint's `.rig/product/sprints/sprint-<N>/testplan/data/`, unchanged, never a copy and never an inline dict.
   - Run it with `S run --expect-fail -- "<test command>"` and see it fail.
   - Write the code.
   - Run `S run -- "<test command>"` and see it pass.
   When `intent.md` has a `from-diff:` line the code already exists: for each behaviour write the test and run it with `S run -- "<test command>"` to see it pass, with no `--expect-fail` step; `/rig-test`'s red-proof then runs the new tests on the base, without the captured code, where they must fail. A test that passes there proves nothing: rewrite the test, never the base.
   Touch only the files plan.md lists. If another file must change, add it under `## Decisions` in plan.md and tell the person, who re-approves. A listed test that pins behaviour this change alters is updated to the new expectation (never an assertion removed or loosened); run the whole suite, not only the new tests, before `/rig-test`.
   When plan.md has `## Phases`, finish and verify one phase before the next, tick it (`- [x]`) and, on a resumed build, start at the first unticked phase.
4. For an operation that can raise, check each step after the commit point (rename, replace, commit, send): it must not make the operation report failure once the change is in place, or the code says why.
5. The hooks run the sensors after each edit and at the end of each turn. Fix what they report; when a finding survives your fix, write in one sentence the premise that fix rested on and check it before the next fix. Never weaken a test, a sensor or a contract file.
6. For a large plan, run at most one `general-purpose` agent with model `sonnet` per independent group of files, in the foreground, each with a brief of at most 60 lines: the behaviours, the files and the test command.
7. When every behaviour has a passing test, continue with `/rig-test <slug>` in this turn.
