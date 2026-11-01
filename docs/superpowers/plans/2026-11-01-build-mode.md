# Build mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a build mode into a target repository: a discipline skill, a locked plan format, gates and a Stop hook. Together they let one local Claude Code session build a project from `SPEC.md` to done without asking anything. Then seed the public `mini-agent-kit` repository for its first run.

**Architecture:** A template under `build-mode/` is copied into the target by `scripts/install-build-mode.ts`. Hooks are dependency-free Node ESM (`.mjs`), so they run in any target. Each hook keeps a pure decision function, tested from the factory with temporary git repositories, separate from a thin I/O runner. A language profile (`build-mode/profiles/python-uv/`) supplies gate commands and small Python gate wrappers.

**Tech Stack:** Node 24 (erasable TypeScript for the installer, plain ESM for hooks), `node:test`, git, Claude Code 2.1.316 hooks. For the target: Python 3.12, uv, pytest, ruff, mypy, and unclebob/crapper, dryer and mutator.

**Spec:** `docs/superpowers/specs/2026-11-01-build-mode-design.md`

## Global Constraints

- The factory repository is never a target. The installer refuses it, using the same rule as `refuseFactoryAsTarget` in `scripts/install-cloud-profile.ts`.
- Protected paths in the target: `.claude/`, `.factory/build.json`, `.factory/gates/`, `SPEC.md`.
- Limits: at most 2 tasks `[!]`; 8 consecutive no-progress blocks; 6 hours wall clock; at most 5 accepted mutants.
- Gate thresholds: CRAP < 10 per function; no duplicate pair with similarity ≥ 0.8; zero surviving mutants apart from accepted ones; no skipped tests.
- Report headers, exactly: `COMPLETE`, `COMPLETE (N accepted mutants)`, `PARTIAL`, `STALLED`.
- No gate is ever dropped. If a gate tool fails on Python, the nearest Python equivalent replaces it at the same threshold, recorded in the design doc's change log.
- The operator's `~/.claude` is never modified. The isolation fallback is `CLAUDE_CONFIG_DIR=~/.claude-build`.
- Run tests with `node --test tests/` (matches `tests/profile/`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The Stop hook itself throws** (bad JSON in `build.json`, git missing). A non-zero exit from a Stop hook lets the session stop silently. Expected: the hook catches everything, and blocks with `build-gate error: <message>` (counted by the no-progress guard). Test in Task 3.
2. **A gate command hangs** (a mutation run stuck on an infinite loop). Expected: killed at its `timeoutSeconds` and reported as a failure naming the timeout. Test in Task 3.
3. **A malformed `PLAN.md`** (a task with no `verify:` line, duplicate numbers, an `after:` naming a task that doesn't exist). Expected: block naming the line number and the problem, not a crash. Test in Task 2.
4. **The installer is run twice, or on a dirty target.** Expected: a second run makes no change and no duplicate hooks. A target with uncommitted changes is refused before anything is written. Test in Task 6.
5. **The hook runs before the first commit, or outside a git repository.** Expected: block with `target is not a git repository with an install commit`, never allow. Test in Task 3.

---

## File map

| Path | Responsibility |
| --- | --- |
| `build-mode/template/.claude/hooks/lib/plan.mjs` | Parse `PLAN.md`; compare against the locked baseline |
| `build-mode/template/.claude/hooks/build-gate.mjs` | SessionStart and Stop hook: state, guards, gates, decision |
| `build-mode/template/.claude/hooks/lib/decide.mjs` | Pure Stop decision function |
| `build-mode/template/.claude/hooks/protect-paths.mjs` | PreToolUse deny for protected paths |
| `build-mode/template/.claude/skills/build-discipline/SKILL.md` | The discipline skill |
| `build-mode/template/.factory/build-prompt.txt` | The fixed start prompt |
| `build-mode/template/.factory/start-build.sh` | Start command, with isolation |
| `build-mode/settings.json` | Hook registrations and permissions merged into the target |
| `build-mode/profiles/python-uv/build.json` | Gate commands, limits and protected paths for uv Python |
| `build-mode/profiles/python-uv/gates/*.py` | Gate wrappers: exit 0 only on pass |
| `build-mode/NOTICE.md` | pstack MIT attribution; note that ub-mode text is not copied |
| `scripts/install-build-mode.ts` | Installer CLI |
| `examples/mini-agent-kit/SPEC.md` | The first target's spec |
| `tests/build-mode/*.test.mts` | Factory tests |
| `docs/build-mode/gate-tools.md` | Probe evidence for gate tools and isolation |

## PLAN.md format (fixed here so the hook can parse it)

```markdown
# Plan

- [ ] 1. Tool registry derives a JSON schema from type hints
  verify: uv run pytest tests/test_registry.py -q
- [x] 2. Fake model replays a script file
  verify: uv run pytest tests/test_fake_model.py -q
  after: 1
  done: 3f2a9c1
- [!] 3. Trace saves as JSON
  verify: uv run pytest tests/test_trace.py -q
  after: 1, 2
  blocked: BLOCKED.md#task-3
```

Rules: tasks are `- [<status>] <n>. <outcome>` with status `space|x|!`. Numbers are unique positive integers. `verify:` is required. `after:` is optional, a comma list of existing numbers, no cycles. `done:` is required on `[x]`, `blocked:` on `[!]`. The last task's `verify:` must be the profile's demo command.

**Lock rule** against the baseline (`git show <first commit adding PLAN.md>:PLAN.md`): every baseline task still exists with the same number, outcome and `verify:`. Its `after:` may only gain entries. New tasks may be added. Status, `done:` and `blocked:` may change.

---

### Task 1: Prove the gate tools on a uv Python 3.12 project and write the profile

**Files:**
- Create: `build-mode/profiles/python-uv/build.json`
- Create: `build-mode/profiles/python-uv/gates/tests.py`, `crap.py`, `dry.py`, `mutate.py`
- Create: `docs/build-mode/gate-tools.md`

**Interfaces:**
- Produces: `build.json` with this shape, which Tasks 3, 6 and 9 read:
  ```json
  {
    "version": 1,
    "spec": "SPEC.md",
    "plan": "PLAN.md",
    "protected": [".claude/", ".factory/build.json", ".factory/gates/", "SPEC.md"],
    "gates": [{ "name": "tests", "run": "uv run python .factory/gates/tests.py", "timeoutSeconds": 900 }],
    "demo": { "name": "demo", "run": "uv run mini-agent demo", "timeoutSeconds": 120 },
    "acceptedMutants": ".factory/accepted-mutants.md",
    "limits": { "maxBlockedTasks": 2, "maxNoProgressBlocks": 8, "wallClockHours": 6, "maxAcceptedMutants": 5 },
    "tools": { "crapper": "<sha>", "dryer": "<sha>", "mutator": "<sha>" }
  }
  ```
  Gate order: `tests`, `lint` (`uv run ruff check && uv run ruff format --check`), `types` (`uv run mypy --strict src`), `crap`, `dry`, `mutate`. `demo.run` is a placeholder; the installer overrides it from `--demo`.
- Produces: each wrapper exits 0 only on pass and prints the offending items on failure. `tests.py` runs pytest with coverage output that crapper needs, and fails on any skipped test (parse `--junitxml`). `mutate.py` fails on survivors not listed in `.factory/accepted-mutants.md` (one line each, `<file>:<line> <mutant id> — <reason>`), or on more than `maxAcceptedMutants` entries.

- [ ] **Step 1: Make a throwaway uv project in the scratchpad.** A `src/` package with two functions (one branching), tests for one of them, plus `pytest`, `pytest-cov`, `ruff`, `mypy` dev dependencies.
- [ ] **Step 2: Install each tool pinned.** Run `uv tool install git+https://github.com/unclebob/<tool>@<sha>` for crapper, dryer and mutator at their current `main` SHAs. Record the SHAs.
- [ ] **Step 3: Run each tool against the project.** Record in `docs/build-mode/gate-tools.md`: the exact command, what it reads (coverage file format and path), where it writes (`.metrics/`), and its exit code with and without a violation. Introduce one violation of each kind: a CRAP ≥ 10 function, a duplicated function, and an untested branch that leaves a surviving mutant.
- [ ] **Step 4: Swap any tool that fails, per Global Constraints.** If a tool won't install or misreads Python, use radon plus coverage for CRAP, `pylint --disable=all --enable=duplicate-code` for duplication, or mutmut for mutation, at the same threshold. Record the swap and why in `gate-tools.md`, and add a dated change-log line to the design doc.
- [ ] **Step 5: Write the four wrappers and `build.json`.** Each wrapper fails on the violation project and passes once the violation is fixed. Record both runs in `gate-tools.md`.
- [ ] **Step 6: Commit.** Message: `feat: add the python-uv build-mode profile with proven gate tools`.

### Task 2: Plan parser and lock check

**Files:**
- Create: `build-mode/template/.claude/hooks/lib/plan.mjs`
- Test: `tests/build-mode/plan.test.mts`

**Interfaces:**
- Produces:
  - `parsePlan(text: string): { ok: true, tasks: Task[] } | { ok: false, errors: { line: number, message: string }[] }`, where `Task = { n: number, status: 'open'|'done'|'blocked', outcome: string, verify: string, after: number[], done?: string, blocked?: string, line: number }`.
  - `checkLock(baseline: Task[], current: Task[]): { ok: true } | { ok: false, problems: string[] }`.
  - `nextTask(tasks: Task[]): Task | null`: the lowest-numbered open task whose `after` are all `done`. An open task depending, even transitively, on a `blocked` task is skipped.
  - `skippedTasks(tasks: Task[]): Task[]`.

- [ ] **Step 1: Write failing tests.**
  - `parses the format example`: the example above gives 3 tasks with statuses `open`, `done`, `blocked` and `after` `[]`, `[1]`, `[1, 2]`.
  - `reports a missing verify line by line number`: errors include `{ line: 1, message: 'task 1 has no verify: line' }`.
  - `reports duplicate numbers, unknown after targets, cycles, done without done:, blocked without blocked:`: one test per case, each asserting the message names the task number.
  - `lock rejects a removed task`: problems equal `['task 2 was removed']`.
  - `lock rejects a changed verify and a changed outcome`: problems name the task and the field.
  - `lock rejects a dropped after entry and allows an added one`.
  - `lock allows status changes and appended tasks`.
  - `nextTask skips tasks that depend transitively on a blocked task`: with `1 [!]`, `2 after 1`, `3 after 2`, `4`, nextTask is task 4, and skippedTasks is `[2, 3]`.
- [ ] **Step 2: Run them and check they fail.** Run `node --test tests/build-mode/plan.test.mts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `plan.mjs`.** Line-based parsing. Continuation lines are the two-space-indented `key: value` lines under a task.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit.** Message: `feat: parse and lock build-mode plans`.

### Task 3: The Stop and SessionStart hook

**Files:**
- Create: `build-mode/template/.claude/hooks/lib/decide.mjs`
- Create: `build-mode/template/.claude/hooks/build-gate.mjs`
- Test: `tests/build-mode/build-gate.test.mts`

**Interfaces:**
- Consumes: `parsePlan`, `checkLock`, `nextTask`, `skippedTasks` (Task 2), and the `build.json` shape (Task 1).
- Produces:
  - `decide(ctx): Decision` in `decide.mjs`, where `Decision = { kind: 'block', reason: string } | { kind: 'allow', header: string }`. `ctx` holds `protectedDiff: string`, `plan: ParseResult | null`, `lock`, `tasks`, `runGates: () => GateResult[]` (called lazily, only when no earlier check blocks), `report: { exists: boolean, fresh: boolean, header: string | null }`, `acceptedMutants: number`, `limits`, `guard: { noProgressBlocks: number, elapsedHours: number }`. `GateResult = { name: string, ok: boolean, tail: string }`.
  - Order, as in the design's numbered checks: protected diff, then plan exists and parses, then lock, then next task, then gates, then report. The guards are checked first. When `guard.noProgressBlocks >= maxNoProgressBlocks`, `elapsedHours >= wallClockHours`, or the blocked count exceeds `maxBlockedTasks`, decide returns `allow` with header `STALLED`.
  - Header when all checks pass: `PARTIAL` if any task is blocked or skipped. Otherwise `COMPLETE`, or `COMPLETE (N accepted mutants)` when N > 0. When the plan is `PARTIAL` and the demo task is blocked or skipped, the demo gate is left out; every other gate runs.
  - Report check: block `write BUILD-REPORT.md with first line "<header>"` unless the report exists, is fresh, and its first line equals the computed header.
  - Runner `build-gate.mjs stop`: reads stdin JSON (uses `cwd`), loads `.factory/build.json`, and finds the install commit with `git log --diff-filter=A --format=%H -- .factory/build.json | tail -1`. The protected diff is `git diff <install> -- <protected>` plus `git status --porcelain -- <protected>`. The plan baseline is the first commit adding `PLAN.md`. Gates run with `spawnSync(..., { shell: true, timeout })`; a timeout gives `tail: 'timed out after <n>s'`. Report freshness: the report's mtime is at or after the last commit time touching anything except `BUILD-REPORT.md`, `DECISIONS.md`, `BLOCKED.md` and `PLAN.md`. The progress fingerprint is HEAD SHA plus the plan's status string: a block with an unchanged fingerprint increments `noProgressBlocks`, a change resets it. State is kept in `.factory/build-state.json` (`startedAt`, `lastFingerprint`, `noProgressBlocks`). Every decision is appended to `.factory/hook-log.jsonl` as `{ at, decision, reason|header, fingerprint }`. On block it prints `{"decision":"block","reason":...}`. On `STALLED` it prepends `STALLED` plus the guard that fired to `BUILD-REPORT.md`, creating the file if needed. It exits 0 always. Any exception becomes a block `build-gate error: <message>`.
  - Runner `build-gate.mjs session-start`: sets `startedAt` if missing, and prints `hookSpecificOutput.additionalContext`: `Build mode: invoke the build-discipline skill now, then continue PLAN.md from its next open task.`

- [ ] **Step 1: Write failing tests for `decide`.** Use plain objects, no git.
  - `blocks on a protected diff`: reason starts with `restore the protected files`.
  - `blocks on a missing plan`: `write PLAN.md from SPEC.md`.
  - `blocks on a parse error naming the line`.
  - `blocks on a lock violation`: `restore the plan`.
  - `blocks when the last task's verify is not the demo command`: reason `the last task must verify with: <demo.run>` (checked by decide, since parsePlan does not know the profile).
  - `blocks on the next open task`: `next task: 4`.
  - `runs gates only after task checks pass`: `runGates` is not called while a task is open.
  - `blocks on a failed gate with its name and tail`.
  - `PARTIAL leaves out the demo gate only when the demo task is blocked or skipped`.
  - `requires the report header to match`: with header `COMPLETE (2 accepted mutants)` and report header `COMPLETE`, it blocks.
  - `allows COMPLETE when everything passes`.
  - `stalls on no progress, on wall clock, and on a third blocked task`: each returns allow `STALLED`.
- [ ] **Step 2: Write failing runner tests.** Each test builds a temporary git repo containing a `build.json` with fast fake gates (`true` / `false` / `sleep 5`), commits it as the install commit, then runs `node build-gate.mjs stop` with stdin `{"cwd": "<repo>"}`.
  - `no git repository blocks`: reason `target is not a git repository with an install commit`.
  - `an edited SPEC.md blocks`.
  - `a gate that sleeps past timeoutSeconds 1 fails as timed out`.
  - `invalid build.json blocks with build-gate error`, and the exit code is 0.
  - `eight unchanged blocks then allows STALLED and prepends it to BUILD-REPORT.md`.
  - `session-start prints the additionalContext line and sets startedAt once`.
- [ ] **Step 3: Run them and check they fail.** Run `node --test tests/build-mode/build-gate.test.mts`. Expected: FAIL.
- [ ] **Step 4: Implement `decide.mjs` and `build-gate.mjs`.**
- [ ] **Step 5: Run the tests again.** Expected: PASS.
- [ ] **Step 6: Commit.** Message: `feat: add the build-mode Stop hook that decides when a build may stop`.

### Task 4: Protected-path PreToolUse hook

**Files:**
- Create: `build-mode/template/.claude/hooks/protect-paths.mjs`
- Test: `tests/build-mode/protect-paths.test.mts`

**Interfaces:**
- Consumes: `protected` from `.factory/build.json`.
- Produces: given stdin `{ cwd, tool_name, tool_input: { file_path | notebook_path } }`, prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<path> is protected by build mode; record the need in BLOCKED.md instead"}}` when the resolved path is inside a protected path. Otherwise it prints nothing. It exits 0 always.

- [ ] **Step 1: Write failing tests.** `denies Write to .claude/settings.json`, `denies Edit to SPEC.md via an absolute path`, `denies .factory/gates/tests.py`, `allows src/app.py and .factory/accepted-mutants.md`, `denies ../ traversal that resolves into .claude/`.
- [ ] **Step 2: Run and check they fail. Then implement. Then run and check they pass.** Command: `node --test tests/build-mode/protect-paths.test.mts`.
- [ ] **Step 3: Commit.** Message: `feat: deny edits to build-mode protected paths`.

### Task 5: Discipline skill, build prompt and notice

**Files:**
- Create: `build-mode/template/.claude/skills/build-discipline/SKILL.md`
- Create: `build-mode/template/.factory/build-prompt.txt`
- Create: `build-mode/NOTICE.md`
- Test: `tests/build-mode/skill.test.mts`

**Interfaces:**
- Produces: a skill named `build-discipline`, with a description that says to use it at build start and after compaction. Its sections: *Make it work* (TDD and see it fail, smallest change, data shape first, boundary checks, fix root causes); *Prove it* (behaviour tests, gates after each task with `mutate.py` on changed files only); *Drive to done* (pstack autonomous run, adapted: fixed predicate never loosened, a plateau means a new approach, fix related problems yourself); *Never ask* (the DECISIONS.md and BLOCKED.md formats from the design, the `[!]` limit, and following PLAN.md format and lock rules); *Pause and pick up* (on resume read PLAN.md, DECISIONS.md and `git log`, never redo work); *Commit* (one commit per task with why, what and proof, then `git push origin main`); *Finish* (write BUILD-REPORT.md in the design's section order).
- Produces: `build-prompt.txt`, exactly: `Build this project. Invoke the build-discipline skill first. SPEC.md is the approved spec. If PLAN.md does not exist, write it; otherwise continue it. Never ask the operator anything. Keep going until the Stop hook lets you stop.`

- [ ] **Step 1: Write a failing test.** `the skill states every rule the hook relies on`. It asserts that SKILL.md contains `DECISIONS.md`, `BLOCKED.md`, `[!]`, `verify:`, `after:`, `BUILD-REPORT.md`, `git push origin main`, and `never loosen`. Also assert that NOTICE.md names pstack, MIT and Lauren Tan, and states that ub-mode text is not included.
- [ ] **Step 2: Run, write the files, and run again until it passes.** Each rule is a short imperative line; the skill stays under 150 lines.
- [ ] **Step 3: Commit.** Message: `feat: add the build-discipline skill and fixed build prompt`.

### Task 6: Installer, settings merge and start script

**Files:**
- Create: `scripts/install-build-mode.ts`
- Create: `build-mode/settings.json`
- Create: `build-mode/template/.factory/start-build.sh`
- Test: `tests/build-mode/install.test.mts`

**Interfaces:**
- Consumes: the template (Tasks 2 to 5), and the profile (Task 1).
- Produces: `installBuildMode({ target, factoryRoot, profile = 'python-uv', demo }: { target: string; factoryRoot: string; profile?: string; demo: string }): { installCommit: string }`. CLI: `node scripts/install-build-mode.ts <target> --demo "<command>" [--profile python-uv]`.
  - It refuses the factory repository itself, a target that isn't a git checkout, a dirty target, and a target with no `SPEC.md`.
  - It copies the template and the profile's `gates/` into `.factory/gates/`, and writes `.factory/build.json` from the profile with `demo.run = <demo>`. It appends `.factory/build-state.json` and `.factory/hook-log.jsonl` to `.gitignore`.
  - It merges `build-mode/settings.json` into `.claude/settings.json`: the hooks for SessionStart (`startup|resume|compact`, timeout 30), Stop (timeout 3600) and PreToolUse (`Edit|Write|MultiEdit|NotebookEdit`, timeout 10), plus allow and deny permissions. Merging is idempotent and matched by command string.
  - Allow list: `Bash(uv *)`, `Bash(python *)`, `Bash(pytest *)`, `Bash(ruff *)`, `Bash(mypy *)`, `Bash(crapper *)`, `Bash(dryer *)`, `Bash(mutator *)`, `Bash(git *)`, `Bash(gh repo view*)`, `Bash(gh api *)`, `Bash(ls *)`, `Bash(mkdir *)`. Deny list: `Bash(curl *)`, `Bash(wget *)`, the four force-push forms from `cloud/rig-profile/permissions.json`, and `Bash(git rebase *)`, `Bash(git reset --hard*)`, `Bash(git commit --amend*)`.
  - It commits `chore: install build mode` and returns that SHA. That commit adds `.factory/build.json`, so it is the install commit the hook finds. A second run with nothing changed makes no commit, and returns the existing install SHA.
  - `start-build.sh`: `cd` to the repo root; set `CLAUDE_CONFIG_DIR` only when `.factory/isolation` contains `config-dir`; then `exec claude --setting-sources project --permission-mode auto "$(cat .factory/build-prompt.txt)"`. Task 7 decides the contents of `.factory/isolation`; the installer writes `setting-sources` by default.

- [ ] **Step 1: Write failing tests.** `installs into a fresh repo and the hooks resolve`, `refuses the factory itself`, `refuses a dirty target before writing anything`, `refuses a target without SPEC.md`, `a second install changes nothing and adds no duplicate hooks`, `keeps existing settings entries`, `the CLI prints the install commit and the start command`, `start-build.sh passes the prompt from build-prompt.txt` (stub `claude` on `PATH` that echoes its args).
- [ ] **Step 2: Run them and check they fail. Then implement. Then run them and check they pass.** Command: `node --test tests/build-mode/install.test.mts`.
- [ ] **Step 3: Run the whole suite.** Run `node --test tests/`. Expected: all pass, including the existing `tests/profile/`.
- [ ] **Step 4: Commit.** Message: `feat: add the build-mode installer and start script`.

### Task 7: Prove isolation and the hook loop with a real session

**Files:**
- Modify: `docs/build-mode/gate-tools.md` (add an Isolation section)
- Possibly modify: `scripts/install-build-mode.ts`, to change the default written to `.factory/isolation`

- [ ] **Step 1: Build a toy target.** In the scratchpad, make a git repo whose `SPEC.md` asks for a one-function Python package. Install build mode with `--demo "uv run python -c 'import toy; print(toy.hello())'"`.
- [ ] **Step 2: Probe isolation.** Run `claude --setting-sources project -p "List every skill you can invoke, one per line, then print the first line of any CLAUDE.md instructions you were given."`. Pass: no `superpowers:` and no `lights-on:` skill appears, `build-discipline` does appear, and no user CLAUDE.md text is shown.
- [ ] **Step 3: If the probe fails, switch to the fallback.** Ask the operator to run `! CLAUDE_CONFIG_DIR=~/.claude-build claude` once to log in. Then write `config-dir` to `.factory/isolation` by default in the installer, and repeat Step 2 with that variable set.
- [ ] **Step 4: Run the real loop on the toy target.** Run `.factory/start-build.sh` in the operator's terminal (the operator starts it; nothing else). Pass: it stops with `BUILD-REPORT.md` headed `COMPLETE`, `hook-log.jsonl` shows at least one block followed by an allow, and there were zero prompts.
- [ ] **Step 5: Record the results and commit.** Record the commands, the outputs and the chosen isolation in `gate-tools.md`. Message: `docs: prove build-mode isolation and the hook loop on a toy target`.

### Task 8: Write the mini agent kit spec

**Files:**
- Create: `examples/mini-agent-kit/SPEC.md`

- [ ] **Step 1: Write SPEC.md** with these sections and pinned values:
  - **Purpose:** an offline, dependency-light toolkit for building tool-using agents, tested end to end with a scripted fake model.
  - **Stack:** Python 3.12, uv, package `mini_agent_kit` under `src/`, console script `mini-agent`. Runtime dependencies: standard library only. Dev dependencies: pytest, pytest-cov, ruff, mypy (`--strict`).
  - **Tool registry:** `@tool` decorator, or `registry.register(fn)`. The JSON schema comes from type hints for `str`, `int`, `float`, `bool`, `list[...]` and `Literal`. The docstring becomes the description. An unknown tool returns `ToolError("unknown tool: <name>")`. Bad arguments return `ToolError` naming the field. Neither raises into the loop.
  - **Model protocol:** `Model.complete(messages, tools) -> ModelReply`, where a reply is either a final text or a list of tool calls (`id`, `name`, `arguments`).
  - **Scripted fake model:** loads a JSON script (a list of turns, each a final text or tool calls). It fails clearly when the script runs out, and can assert the tool results it received when a turn says `expect`.
  - **Agent loop:** `run(question, model, registry, max_steps=8) -> RunResult` (final answer, steps, stop reason `final|max_steps|error`). Tool calls in one reply run in order.
  - **Trace:** each step records the messages sent, the reply, tool results and duration. `RunResult.to_json()` round-trips through `RunResult.from_json()`.
  - **Demo:** `mini-agent demo` runs the bundled script, which asks "What is 17 * 23, and how many words are in 'the quick brown fox'?". It uses the `calculator` and `word_count` tools plus `clock`, prints each step as `step N: <tool>(<args>) -> <result>`, and ends with a line `answer: 391; 4 words`. Exit 0.
  - **Done means:** all build-mode gates pass and the demo output matches the line above.
- [ ] **Step 2: Commit.** Message: `docs: draft the mini-agent-kit spec for the first build-mode run`.

### Task 9: Create and seed the public mini-agent-kit repository

Outward-facing. The operator approved creating `cwijayasundara/mini-agent-kit` as public on 2026-11-01.

- [ ] **Step 1: Create and clone the repository.** Run `gh repo create cwijayasundara/mini-agent-kit --public --description "A tiny offline agent kit, built unattended by the lights-on factory"`, then clone it to `~/Documents/learning_102/mini-agent-kit`.
- [ ] **Step 2: Add the seed files and commit.** Copy `examples/mini-agent-kit/SPEC.md`. Add a two-line `README.md` (what it is, and that it is built by build mode from SPEC.md) and a Python `.gitignore`. Commit `docs: add the spec`.
- [ ] **Step 3: Install build mode.** Run `node scripts/install-build-mode.ts ~/Documents/learning_102/mini-agent-kit --demo "uv run mini-agent demo"`. Expected: it prints the install commit and the start command.
- [ ] **Step 4: Push and check.** Run `git push origin main`. Then `gh api repos/cwijayasundara/mini-agent-kit/commits --jq '.[0].commit.message'` should print `chore: install build mode`.
- [ ] **Step 5: Start the record and hand over.** Create `docs/experiments/03-build-mode-mini-agent-kit.md` in the factory, with the design's measures table and empty results, and commit it. Then give the operator the one start command: `cd ~/Documents/learning_102/mini-agent-kit && .factory/start-build.sh`. Stop here.
