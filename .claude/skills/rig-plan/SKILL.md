---
name: rig:plan
description: Plan an active change - write plan.md (files, interfaces, tests per behaviour, contracts, verification) and hand it to a person for approval.
argument-hint: '[<slug>]'
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts *), Read, Grep, Glob, Write, Edit, Agent, Skill
---
# Plan a change

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`.

1. Run `S status --json` and take `$0` or the active change. It must have `spec.md`; otherwise run `/rig-start` first.
2. Read `.rig/changes/<slug>/requirements.md` when it exists (the PRD rows this change must meet; never edit it). For a change started from a charted intent, read that intent's `### <slug>` section of `implementation-plan.md` in its sprint folder first: its files, interfaces and tasks are the starting point, so keep them unless `spec.md` changed what they rest on, and say in `## Decisions` what you changed and why. Run `S weight <slug>` first. `light`: do not invoke `superpowers:writing-plans`; write `plan.md` yourself in at most 30 lines with the sections below except `## Phases`, which a light plan never has. `full`: invoke `superpowers:writing-plans` (when `S superpowers` prints a `WARNING`, show it in one line and write `plan.md` yourself as a light plan does, with the `## Phases` section) on `.rig/changes/<slug>/spec.md`, writing the result to `.rig/changes/<slug>/plan.md` in rig's shape below, in at most 60 lines: plans hold interfaces and acceptance tests, never code bodies, so keep the skill's task granularity but not its code blocks; write only `.rig/changes/<slug>/plan.md` (not `docs/superpowers/plans/`), and skip the skill's execution-method question: rig's next step is always `/rig-approve <slug>` by a person.
   - `## Files`: the files you expect to touch, all inside the spec's `## Blast radius`. Search the existing tests (Grep their directories for each name or shape this change alters) and list every existing test whose expectation this change makes wrong, with its new expectation under `## Tests`. Updating a test that pins the behaviour this spec changes is part of the change; deleting or weakening an assertion is not.
   - `## Interfaces`: signatures and data shapes, never code bodies. For a change started from a charted intent, cite the intent's `## Design` rows instead of restating them, and give a test for each `### Failure behaviour` line.
   - `## Phases` (only when the plan has more than one group of files): `- [ ] Phase N: <title>` per phase, each a thin end-to-end step that crosses layers and is verifiable alone with automated checks (manual ones only where a person's judgement is needed); never "all types, then all endpoints, then the UI". Show the shape of a phase with the views in `.rig/templates/show-me.md`.
   - `## Tests`: one line per behaviour, giving the B-number, the test file and the level (unit, contract or end-to-end).
   - `## Contracts`: contract files this change adds or edits, or `none`.
   - `## Verification`: the commands that prove it.
   - `## Decisions`.
   - `## Open questions`: `none`.
3. Run `S queue --check <slug>`: it lists any file this plan names that another in-flight plan (in another worktree) already holds. If it prints a conflict, stop and tell the person: one writer per file, so the other change lands first or the work is split. Never plan around it by hiding the file. Then run `S approve <slug> --check` and fix plan.md until it prints `ok`; never hand a plan to the person that this check refuses.
4. A change that adds or edits a contract file (`contracts.files` in `.rig/sensors.json`) makes that edit now, before approval, because approval freezes those files.
5. Launch `rig-evaluator` once in change plan mode ("review the plan for change <slug>"; Opus by its front matter; never pass a model override) and write its reply to `.rig/changes/<slug>/plan-review.md`. It reviews spec.md and plan.md against the intent and requirements.md: a missed requirement, a behaviour without a test, a plan outside the spec. Fix its findings once, then run `S approve <slug> --check`.
6. Ask the person to review `spec.md` and `plan.md` and to run `/rig-approve <slug>`. Never approve yourself. End with `Next: /rig-approve <slug> (a person), then /rig-build <slug>`; from there the build runs through verify, the PR and the review's fixes without stopping. If `.rig/sensors.json` sets `"gates": { "plan": false }`, skip the request and end with `Next: /rig-build <slug>`.
