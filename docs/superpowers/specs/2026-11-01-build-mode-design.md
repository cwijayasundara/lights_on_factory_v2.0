# Build mode: unattended greenfield builds from a spec

Date: 2026-11-01. Status: approved by the operator 2026-11-01.

## Intent

The operator designs a project with Claude Code: research, decisions and a written spec, committed to a repository. Then they hand it to the factory and walk away. The factory builds the whole project without asking anything. When it stops, the operator checks three things in order: green tests, a working demo, then the decision log.

The operator does not want to babysit sessions. The Rig cloud work (experiments 1 and 2) never produced a build, and it targets a different loop: an issue becoming a PR in an existing repository. Build mode targets a new project built from its spec.

## Goals

- One command starts a build. No prompts, questions or approvals until it stops.
- The run cannot declare itself done. A deterministic Stop hook decides when it may stop.
- Every judgement the agent makes alone is written down, so the operator can audit it afterwards.
- The discipline lives in the target repository, so the same files later work in a cloud session.
- First proof: the factory builds the "mini agent kit" (below) in a new public GitHub repository, with zero human interventions.

## Non-goals

- Cloud sessions, routines and triggers. The first run is local. The design keeps files repository-local so cloud is a later step, not a rewrite.
- Pull requests, reviews and merge gates. The build commits and pushes straight to `main` of a new repository the operator owns.
- Changing existing projects. Build mode is for a new repository built from a spec.
- Replacing the Rig path. The Rig cloud profile stays as it is; build mode does not use or remove it.
- Installing pstack, ub-mode or any plugin into the operator's own Claude setup.

## Anti-goals: the run fails even if it ends green when

- The agent edits the gates, thresholds, hook or spec to get green.
- Tests pass without proving behaviour: assertions that would pass if every function returned nothing, deleted tests, or skipped tests.
- It stops early and calls a half-built project done, or the report hides that it is partial.
- It asks the operator a question or waits on a prompt.
- A user-level skill (superpowers brainstorming, for example) starts a conversation inside the run.

## The pieces

Build mode is four things installed into the target repository, plus one start command.

### 1. The plan: `PLAN.md`

The run's first job is to turn `SPEC.md` into `PLAN.md`: a numbered checklist of small tasks in build order. Each task has:

- a one-line outcome,
- a `verify:` line with the exact shell command that proves it, which must exit 0,
- a status: `[ ]` open, `[x]` done (with the commit SHA), or `[!]` blocked (with a pointer into `BLOCKED.md`).

The last task is always the demo: running the spec's demo command and showing its output. Nobody approves the plan. The operator approved the spec, and the plan is the agent's work. *(Designer's call. The operator wants no checkpoints.)*

**The plan locks once written.** The first commit that adds `PLAN.md` is its baseline, recorded by the hook in `.factory/build-state.json`. After that the hook rejects any diff against the baseline that removes a task or changes an existing task's outcome or `verify:` line. Allowed changes: status marks, new tasks appended, and splitting a task into sub-tasks that keep the parent's `verify:` line. At most 2 tasks may be `[!]`; a third block means the run stops as `STALLED`. *(Designer's call. Otherwise the agent controls its own definition of done.)*

### 2. The discipline skill: `.claude/skills/build-discipline/SKILL.md`

Our own skill, written fresh. ub-mode has no license, so its text is not copied. It covers:

- **From ub-mode's ideas:** test first and see it fail; the smallest change that passes; get data shapes right first; check data at the boundary and trust it inside; fix root causes; one verifiable unit at a time; test behaviour, not implementation; small commits that say why, what changed, and how it was proved.
- **From pstack (MIT, adapted with attribution):**
  - *Autonomous run.* Done is a checkable predicate fixed before starting. Never loosen it to declare victory. A plateau means try another approach, not stop. Fix related problems yourself.
  - *Pause safely* and *session pickup.* Leave state on disk; on resume, read `PLAN.md`, `DECISIONS.md` and `git log` instead of redoing work.
- **The no-questions rule.** Never ask the operator anything. When the spec is silent, pick the simplest choice that fits it, record it in `DECISIONS.md` (choice, reason, where in the code), and continue. When a task truly cannot be finished, write it to `BLOCKED.md` (what was tried, why it failed, what the next attempt would be), mark it `[!]` and move to the next task that does not depend on it.
- **Gates.** Use the gate tools after every task, and fix what they report before moving on.

The skill tells the agent to invoke it at the start of the run and after any context compaction.

### 3. The gates: `.factory/build.json`

Commands and thresholds, written by the installer and owned by the operator.

| Gate | Tool | Pass |
| --- | --- | --- |
| Tests | the project's test command (`uv run pytest` for the kit) | exit 0, no skipped tests |
| Lint and types | `uv run ruff check`, plus the type checker the spec names | exit 0 |
| Complexity | [unclebob/crapper](https://github.com/unclebob/crapper) (0BSD) | every function CRAP < 10 |
| Duplication | [unclebob/dryer](https://github.com/unclebob/dryer) (0BSD) | no pair at similarity ≥ 0.8 |
| Mutation | [unclebob/mutator](https://github.com/unclebob/mutator) (0BSD) | zero surviving mutants, except ones listed with a reason in `.factory/accepted-mutants.md` |
| Demo | the spec's demo command | exit 0 |

crapper, dryer and mutator are installed as uv tools pinned to a commit SHA. If one of them does not work on a uv Python 3.12 project, the builder swaps in the nearest Python equivalent with the same threshold (radon plus coverage for CRAP, pylint's duplicate-code check for duplication, mutmut for mutation), records the swap in this document's change log and in the experiment record, and tells the operator. A gate is never dropped. *(Designer's call.)* Mutation testing is slow, so the agent runs mutator on the files it changed after each task, and the Stop hook runs it on everything at the end. The agent may add accepted mutants, each with a one-line reason saying why the mutant is equivalent. A run with accepted mutants can still be `COMPLETE`, but the header then reads `COMPLETE (N accepted mutants)` and the report lists each one, so loosening by that route is visible on the first line. More than 5 accepted mutants fails the mutation gate. *(Designer's call. Zero survivors with no escape hatch can loop forever on equivalent mutants.)*

Not yet verified: that the three tools install and run cleanly on a uv Python 3.12 project. The plan's first factory task proves this before anything depends on it.

### 4. The driver: the Stop hook, `.claude/hooks/build-gate.mjs`

This runs on every Claude Code `Stop` event and decides whether the session may end. Node, no dependencies, so it needs nothing from the target's toolchain. It checks, in order:

1. **Protected files unchanged.** `git diff <install commit> -- .claude/ .factory/build.json SPEC.md` must be empty. If not, block: "restore the protected files". The install commit SHA is recorded in `.factory/build.json`.
2. **The plan exists and parses.** If not, block: "write PLAN.md from SPEC.md".
3. **Plan intact.** The plan matches its locked baseline (see above). If not, block: "restore the plan".
4. **No open tasks.** If any `[ ]` task has all its dependencies done, block: "next task: N". A `[ ]` task that depends on a `[!]` task is skipped, not open.
5. **Full gates pass.** Run every gate in `build.json`. If any fails, block with the gate's name and the last 40 lines of its output. When tasks are blocked, the demo gate is waived only if the demo task is itself skipped or blocked; every other gate must still pass. That stop is `PARTIAL`.
6. **The report exists.** `BUILD-REPORT.md` must exist and be newer than the last commit that changed code. If not, block: "write BUILD-REPORT.md".
7. **Allow the stop.**

**Loop guards.** State lives in `.factory/build-state.json` (gitignored). The hook allows the stop and stamps the report header `STALLED` when either of these is hit:

- 8 blocks in a row with no new commit and no task status change, or
- a wall-clock budget, 6 hours by default, set in `build.json`.

Every block and every allow is appended to `.factory/hook-log.jsonl`, so the run can be reconstructed afterwards.

A PreToolUse hook also denies Edit/Write to the protected paths, so the agent finds out at once rather than at the Stop check. Bash edits to them are caught by check 1.

### The report: `BUILD-REPORT.md`

The agent writes it last, in the order the operator reads it:

1. A header line: `COMPLETE`, `PARTIAL` (one or more tasks blocked), or `STALLED` (a loop guard fired).
2. **Tests.** The exact command, its output summary, coverage, and each gate result against its threshold.
3. **Demo.** The command to paste, and the output it printed.
4. **Decisions.** A link to `DECISIONS.md` with the count, and a link to `BLOCKED.md` (empty when clean). Accepted mutants are listed here.
5. **Tail.** Tasks done out of total, commits, and wall time.

## Run setup

- **Installer.** `scripts/install-build-mode.ts` copies the `build-mode/` template into a target checkout, merges the hook registrations and permission policy into `.claude/settings.json`, records the install commit, and commits. Same style and test approach as `scripts/install-cloud-profile.ts`: Node 24, erasable TypeScript, built-in Node tests. It refuses to install into the factory repository itself.
- **Permissions.** Auto mode, plus an allowlist for `uv`, `python`, `pytest`, `ruff`, the gate tools, `git` (no force-push), and `gh` read commands. `curl` and `wget` are denied. Installing packages from PyPI through `uv` is allowed.
- **Isolation from the operator's setup.** A local session also loads user-level plugins and `~/.claude/CLAUDE.md`. In the run, superpowers' brainstorming would start asking questions, which breaks the main goal. The start command must load project settings only, or disable user plugins for the session. The builder verifies the mechanism (a `--setting-sources` flag, project-level `enabledPlugins` overrides, or similar) and proves it with a probe before the real run. If no built-in mechanism shuts user plugins out, the fallback is a dedicated config folder for builds (`CLAUDE_CONFIG_DIR`, for example `~/.claude-build`), logged in once by the operator. The operator's own `~/.claude` is never changed. *(Operator's choice, 2026-11-01.)*
- **Start command.** One line, printed by the installer, run from the target checkout. Something like `claude --permission-mode auto "<build prompt>"`; the builder verifies the exact flags. The build prompt is fixed and short: invoke build-discipline, build `SPEC.md` to done, never ask. If the session dies, the same command resumes from what is on disk (session pickup).
- **Pushing.** Commit after each task, then `git push origin main`. The operator can watch progress on GitHub.

## The first target: mini agent kit

The factory builds `cwijayasundara/mini-agent-kit`, a new **public** GitHub repository (the operator's choice). The spec is drafted by the designer, not the operator, because this run tests the build loop, not spec writing. The plan includes writing `SPEC.md` in full. Its scope:

- **Tool registry.** Register a plain typed Python function as a tool. The input schema comes from its type hints. Arguments are validated before the call. An unknown tool or bad arguments returns an error to the agent rather than raising.
- **Model protocol.** A small interface a real provider could implement later. Only the fake one is built.
- **Scripted fake model.** Replays a scripted conversation from a JSON or YAML file, so runs are deterministic and offline.
- **Agent loop.** Send messages to the model, run the returned tool calls, feed the results back, and stop on a final answer or a step limit.
- **Run trace.** Every step recorded and saveable as JSON.
- **CLI demo.** `uv run mini-agent demo` answers a question with two or three toy tools (calculator, clock, word count) and prints each step.
- Python 3.12, uv, pytest, ruff. No network, no API keys. Roughly 10 plan tasks.

Creating the public repository is an outward-facing step. It happens once, after the operator approves this design.

**Scope of the implementation plan.** The plan builds the factory side (template, skill, hooks, installer, tests), proves the gate tools and the isolation mechanism, creates and seeds the kit repository (`SPEC.md` and the build-mode install), and stops at the start command. The operator runs that command. Writing up the experiment record afterwards is a separate step.

## Measuring the run

Recorded in `docs/experiments/03-build-mode-mini-agent-kit.md`:

| Measure | Pass |
| --- | --- |
| Human interventions after the start command | 0 |
| Report header | `COMPLETE` |
| Gates at the end, re-run by the operator | all pass |
| Demo, run by the operator | prints the expected steps |
| Protected-file violations caught | any number is fine if the run recovered on its own |
| Decisions | each is sensible on a read-through |

## Left to the builder

- Exact `PLAN.md` syntax, as long as the hook can parse status, verify command and dependencies deterministically.
- How dependencies between tasks are written.
- The exact text of the discipline skill, within the rules above.
- Hook implementation details, the state file format, and log fields.
- The kit's internal module layout, and its YAML or JSON choice for scripts.
- The exact Claude Code flags for auto mode and for loading project settings only, verified against current docs.

## Change log

- 2026-11-01, from building and reviewing it:
  - The Stop hook runs from the install commit (`git archive` into a temp dir), not the working tree, and exits 2 (block) if it can't load or crashes.
  - Protected files are compared by content against the install commit, so git index tricks can't hide an edit.
  - The install commit is the latest `chore: install build mode` commit; `build.json` carries a `templateHash`, so every upgrade makes one.
  - Before the gates, the hook re-runs each `[x]` task's `verify:` and checks its `done:` commit is on the branch.
  - The cheap checks (committed, pushed, report) run before the full gates, so the gates run once at the end.
  - A locked task may gain `after:` only on other locked tasks.
  - Gate wrappers fail closed on unparseable or empty tool output, clear stale reports, run ruff `--isolated` and mypy with a protected config, and refuse pytest config that drops tests.
  - Gate tools run from pinned clones rather than `uv tool`, because mutator needs crapper beside it.
