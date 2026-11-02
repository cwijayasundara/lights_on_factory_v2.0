# Behavioral harness: from a build-mode installer to a lifecycle harness

Date: 2026-11-01. Status: draft, awaiting operator review.

## Intent

Build mode (`scripts/install-build-mode.ts`) copies one skill, two hooks and six gates into a target repository, so the operator can hand it a `SPEC.md` and walk away. It works: `mini-agent-kit` went to COMPLETE in 11 tasks, 109 tests, 100% coverage, zero mutants accepted, 14 commits.

But it is scaffolding for one event (the first build), not a harness for the life of the project. This design turns it into a behavioral harness in the sense of Böckeler and Jain: guides that steer the agent before it acts, sensors that check after, and an independent acceptance check the agent cannot touch. It takes selected discipline from superpowers, Matt Pocock's skills, ub-mode, Addy Osmani's agent-skills and factory, and pstack, and keeps them coherent by splitting them across modes instead of stacking them.

## Evidence this design rests on

### Observed in `mini-agent-kit` (verified from files)

1. **No lifecycle after COMPLETE.** The build reached COMPLETE at 11:17 on 2026-11-01. At 19:03, 19:10, 19:26 and 19:31 the Stop hook ran again during follow-up work (adding `fireworks.py`) and logged `STALLED: wall clock budget of 6 hours used` (`.factory/hook-log.jsonl`). Cause, in `build-gate.mjs`: `state.startedAt ??= ...` is set once and never reset, and nothing switches the hook off after COMPLETE. `stamp()` prepends `STALLED` to the existing report each time, so `BUILD-REPORT.md` now opens with four stacked STALLED headers above the real COMPLETE report.
2. **Guides are thin.** The target has one skill and no `CLAUDE.md`, glossary or ADRs. Everything else is sensors.
3. **Builder and checker share a source.** The agent writes the tests and the code. The mutation gate shows the tests are strong, not that they test the right thing.
4. **Protected paths exclude tests.** The skill says "never weaken a test", but nothing checks it.
5. **One profile, one stack.** The only profile is `python-uv`, and the installer needs a clean tree and a `SPEC.md`.
6. **No cost data.** `hook-log.jsonl` records decisions, not tokens or time per gate, so the harness's cost cannot be judged.

### From the literature

- **Böckeler, [Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html) (2 Apr 2026):** guides (feedforward) plus sensors (feedback). Computational controls are cheap and deterministic. Inferential ones are slower and less deterministic. Three regulation categories: maintainability (easy), architecture fitness, and behaviour ("the elephant in the room"). Keep quality left: fast checks early, expensive ones in the pipeline. Open problems: coherence of the harness, trade-offs when signals conflict, and evaluating the harness itself ("if sensors never fire, is that quality or blindness?").
- **Jain, [Are Harnesses Worth the Cost?](https://martinfowler.com/articles/are-harnesses-worth-the-cost.html) (13 Oct 2026):** a single greenfield Java service, 10 paired runs per model, low reasoning effort, guides and sensors added together. Frontier model: 10/10 with or without the harness, about 6.6× the cost with it. Cheap model: 3/10 without, 10/10 with, and harnessed-cheap cost about a third less per accepted run than unharnessed-frontier. Conclusion: what changes with model capability is when sensors run, not whether they are needed. Frontier: run once as a final acceptance gate. Cheap: run throughout. Always keep an independent acceptance check, and never let the agent weaken expectations to pass. Limits: one service, small sample, authoring and maintenance cost not counted.

## Goals

- One harness covers three phases of a project's life: shape, build, maintain. Each phase has its own guides, sensors and stop rule.
- A behaviour layer: acceptance checks derived from the spec by a separate agent, protected from the builder, run at the end.
- Sensor intensity depends on the model tier, and the harness's cost and effect are measured, not assumed.
- The harness tests itself: known defects are injected and the gates must fire.
- The discipline stays repository-local, as in build mode, so it later works in a cloud session.

## Non-goals

- Installing superpowers, pstack, agent-skills or Matt's skills as plugins into the target. We port selected ideas into our own short skills.
- Cloud sessions, routines, PR or merge flow. Those stay with the Rig and cloud work.
- A general multi-language framework in the first cut. Profile detection comes later in the roadmap.
- Dollar-accurate cost accounting. We record tokens and wall time per gate and per run, and compare relative cost.

## Anti-goals: the harness fails even if gates are green when

- Any two sources give the agent contradictory instructions (for example a skill that says ask, beside one that says never ask), or the harness grows faster than we can say what each piece is for.
- The agent edits an existing test assertion, the acceptance suite, a gate, or a threshold to get green.
- The stop rule from one phase leaks into another (the failure in "Observed" item 1).
- A user-level skill starts a conversation inside an unattended run. Isolation (`--setting-sources project`) stays.
- A layer is added with no stated failure it prevents and no way to tell whether it fired.

## Modes

A repository is in exactly one phase, recorded as `phase` in `.factory/build.json`: `shape`, `build` or `maintain`. A SessionStart hook reads it and injects the matching skill pointer.

| | shape | build | maintain |
| --- | --- | --- | --- |
| Who is in the loop | operator, interactive | nobody | operator, interactive |
| Questions allowed | yes, one at a time | never | yes |
| Output | `SPEC.md`, `GLOSSARY.md`, ADRs, acceptance examples | code, `PLAN.md`, `DECISIONS.md`, `BLOCKED.md`, `BUILD-REPORT.md` | focused changes, one commit each |
| Stop rule | none; operator ends the session | Stop hook runs all gates; wall clock and no-progress limits | Stop hook runs fast gates and the acceptance suite; no clock; never writes `BUILD-REPORT.md` |
| Transition | operator approves spec, runs install | Stop hook allows with `COMPLETE`, then flips `phase` to `maintain` in a commit | operator re-enters `shape` for a new feature set |

The flip to `maintain` is the minimal fix for the observed defect and ships first.

## Layers

### 1. Guides (feedforward)

Short, each with a stated failure it prevents.

| Piece | Prevents | Source |
| --- | --- | --- |
| `CLAUDE.md` in the target: three to ten lines, names the phase, points at skills and the glossary | Agent starting without context or with the wrong stop rule | Böckeler (guides); Matt (`setup` per repo) |
| `GLOSSARY.md` and `docs/adr/` | Verbose or drifting vocabulary, re-litigated decisions | Matt (`grill-with-docs`) |
| `shape` skill: grill the operator one question at a time, then write the spec, glossary, ADRs and acceptance examples | Misalignment before building | Matt (`grill-me`, `to-spec`); superpowers (`brainstorming`) |
| `build-discipline` skill (exists) | Skipped tests, hidden gate edits, asking in an unattended run | ub-mode ideas; pstack autonomous-run |
| `principles` skill: laziness protocol, subtract before add, fix root causes, prove it works, each with an excuse-and-rebuttal table | The usual shortcuts an agent talks itself into | Osmani (anti-rationalization tables); ub-mode; pstack `principle-*` |
| `debug` skill: reproduce first, write the failing test, find the cause, then fix | Guess-and-patch fixes | superpowers (`systematic-debugging`); Matt (`diagnosing-bugs`); Osmani (Prove-It) |
| Skill-use bootstrap (extend the existing SessionStart hook): process skills outrank implementation skills; a skill that applies is used | Skills that exist but are never read | superpowers (`using-superpowers`) |
| Executable task format (`verify:` command per task) | Tasks with no checkable outcome | pstack overnight contract; already in `PLAN.md` |

Rules for guides: each is under about 150 lines; the always-loaded part (`CLAUDE.md` and the bootstrap) is under about 40 lines; detail loads on demand. Osmani's 25 skills and 9 commands are the cautionary example of context cost.

### 2. Fast sensors (computational, shifted left)

A PostToolUse hook on `Edit|Write|MultiEdit` runs the profile's `fast` command (ruff and mypy on the touched file) and returns failures as additional context written for the model. The Stop hook still runs everything. Goal: errors surface seconds after the edit, not at Stop. Source: Böckeler, "keep quality left".

### 3. Full sensors (computational, at Stop)

Unchanged: tests, lint, types, CRAP, DRY, mutation, demo. Gate levels follow Osmani's `fast`/`full`/`deep` idea and are listed in `build.json`. A required gate that cannot run is a hard failure, never a skip.

### 4. Behaviour layer (the new part)

This is Böckeler's open gap and Jain's outer loop.

- **Acceptance suite.** In the `shape` phase, after the spec is approved, a separate agent that has not seen any implementation writes executable acceptance checks from the spec's examples (the spec's demo output, error cases, boundaries). They live in `acceptance/` and are listed under `protected` in `build.json`. The builder agent may run them but cannot edit them (PreToolUse deny, plus the Stop hook's content comparison against the install commit).
- **When it runs.** Frontier tier: once, at Stop. Cheap tier: also after each task (see Tiers).
- **No-weakening guard.** At Stop, a diff of test files against the install commit rejects any removed or loosened assertion in an existing test (new test files are allowed). Source: Osmani's factory ("unattended runs may not modify an existing test file").
- **Proof the test needs the fix.** For each task commit that adds a test, revert the non-test hunks in a clean worktree and require that the test fails. Result lines `PROVEN`, `FAILED` or `MISCONFIGURED`. Source: Osmani's `prove-test.sh`. Costly, so it runs at Stop on the task commits, not after each edit.
- **Why separate source.** Jain: tests and implementation written from the same reading can share the same omission.

### 5. Inferential sensor

One adversarial review on the final diff by a model other than the builder, following pstack's `/interrogate`: it tries to break the change by running real code, and only findings whose rerun reproduces a failure are reported. It reports and applies nothing. Runs once at the end of `build` and optionally at the end of a `maintain` change. The model comes from `~/.claude/rules/pstack-models.md` (`interrogate reviewers`). Writer does not grade the work (Osmani).

### 6. Control rules (from Osmani's factory, adapted)

- **Numeric stop conditions** in `build.json`, in addition to the existing limits: two red attempts on the same gate without a code change, a touch of a load-bearing path, more than N changed lines in a task.
- **Load-bearing paths** as globs (for example migrations, auth, the harness's own `.claude/` and `.factory/`) force the `deep` gate set and a note in the report.
- **Charter in the repo.** `CLAUDE.md` plus `SPEC.md` is the default-deny charter: work not covered by them stops as BLOCKED, not guessed.

## Tiers and cost

Jain's result implies the harness should not be uniform. `build.json` gains `tier: frontier | economy`.

| | frontier | economy |
| --- | --- | --- |
| Per edit | fast sensors | fast sensors |
| Per task | task `verify:` only | `verify:` plus `full` gates minus mutation, plus acceptance suite |
| At Stop | all gates, acceptance suite, prove-test, interrogate | all gates, acceptance suite, prove-test, interrogate |

The installer picks the default from the operator's model configuration and the operator can override it. This is a hypothesis to test, not a settled rule.

**Measurement.** Add `.factory/runs/<timestamp>.json` per session: model, tier, tasks done, wall time, time per gate, gate failures by name, blocks, and token counts where Claude Code exposes them (if it does not, record `null`, not an estimate). This lets us compute cost per accepted run.

## Evaluating the harness itself

Böckeler asks for something like mutation testing for harnesses. Two cheap checks:

1. **Seeded-defect check.** A script injects known defects into a copy of a passing repo (a dropped validation, an off-by-one, a deleted assertion, an edited protected file) and records which gate catches each. A defect no gate catches is a hole to close or document.
2. **Fire-rate report.** From `hook-log.jsonl` and the run records, report how often each gate blocked. A gate that never fires across several builds gets reviewed: is the code good, or the gate blind?

Run the seeded-defect check in `tests/profile/` with the existing profile tests.

## Source map: what we take and what we leave

| Source | Take | Leave |
| --- | --- | --- |
| [superpowers](https://github.com/obra/superpowers) | Bootstrap that makes skill use non-optional; process before implementation; systematic debugging; verification before completion; fresh subagent per task with review | Mandatory interactive brainstorming inside `build`; install-as-plugin |
| [mattpocock/skills](https://github.com/mattpocock/skills) | Grilling, glossary, ADRs, spec-to-tasks, TDD, diagnosing bugs, user-invoked vs model-invoked split | Skills for issue trackers and triage; the full catalogue |
| [ub-mode](https://github.com/unclebob/ub-mode) | Laziness protocol, subtract before add, CRAP < 10, DRY at 0.8, mutation (already in gates); practice section (log, context guard) | Copying its text: build-mode's spec records that it has no license, so we write our own wording from the ideas. Re-check before quoting anything |
| [addy osmani agent-skills](https://github.com/addyosmani/agent-skills) | Excuse-and-rebuttal tables; evidence-based verification checklists; `fast`/`full`/`deep` gate levels | 25 skills, 9 commands, four interactive spec gates |
| Osmani's factory (`docs/research/2026-10-31-addy-osmani-factory.md`) | No-edit-existing-tests; load-bearing paths; numeric stop conditions; writer is not the grader; prove-test | Issue-label queue, routines, merge policy (different project) |
| [pstack](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/README.md) | Task-type playbooks (bug fix, feature); overnight contract (checkable finish, escape hatch, decision log); `/interrogate`; short principle skills; the Claude Code mapping | Cursor-only automations; arena and swarm until we have a case that needs them |

Licences for superpowers, agent-skills and pstack were not checked for this draft (pstack is MIT per its own NOTICE use in `build-mode/NOTICE.md`; confirm the rest). Wording is our own either way.

## Roadmap

Each step is a separate plan with its own tests. Do not start the next until the current one has shown its effect.

1. **Lifecycle fix.** Add `phase`; Stop hook flips to `maintain` on COMPLETE; `maintain` runs fast gates only, no clock, never stamps the report; stop stacking STALLED headers (replace the header line, do not prepend). Test: replay the `mini-agent-kit` log, where a post-COMPLETE session must not be marked STALLED.
2. **Behaviour layer, part 1.** `acceptance/` path in `protected`; no-weakening guard on existing tests; Stop hook runs the suite.
3. **Run records and measurement.** `.factory/runs/*.json`.
4. **`shape` skill and glossary/ADR templates.** Plus the acceptance-writer step.
5. **Paired experiment** (see below). Decide tiers from the data.
6. **PostToolUse fast sensors; tiers in `build.json`.**
7. **Prove-test and the interrogate review.**
8. **Seeded-defect check and fire-rate report.**
9. **Profile detection** beyond `python-uv`.

## Experiment: is each layer worth it?

Modelled on Jain. Spec: `examples/mini-agent-kit/SPEC.md`. Arms: (a) no harness, (b) current build mode, (c) build mode plus behaviour layer. Models: one frontier, one economy. Ten runs per cell if budget allows, fewer if not, and say so. Outer loop: an acceptance suite written by a separate agent, hidden from the builder in every arm. Record: accepted/total, tokens, wall time, hook blocks, interventions. Predictions from Jain: economy shows the gap between arms, frontier does not. If frontier shows no gain from (b) or (c) over (a), tier it down to final-gate only.

## Open questions for the operator

1. Is `maintain` interactive (the operator at the keyboard) or should it also support unattended small fixes with the same gates?
2. Which model tiers do you actually run builds on? That decides whether the economy tier is worth building.
3. Should the acceptance writer be a fresh Claude Code session started by the installer, or a step the operator runs in `shape`?
4. How much cost is acceptable per build? Jain's frontier-with-harness run cost about 6.6× the unharnessed run.

## Limits of this research

- Web sources were read through a summarizing fetch, not as raw files. ub-mode's `SKILL.md`, superpowers' hook code and pstack's playbooks were not read directly, so claims about them come from READMEs and indexes.
- Jain's study is one service, one reasoning setting, a small sample, and guides and sensors were not separated. Tier rules here are hypotheses.
- The lifecycle defect is established from the hook code and log. The 6-hour trigger is explained by `startedAt` never resetting, and I did not re-run the hook to reproduce it.
