---
name: rig:approve
description: Human only. Approve a change (its spec.md, plan.md and contract files) or a sprint chart (chart-N, which covers a converted PRD too). The model cannot run this.
argument-hint: <slug | chart-N>
disable-model-invocation: true
allowed-tools: Bash(SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts approve *), AskUserQuestion, Skill
---
!`SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts approve '$ARGUMENTS' --ask 2>&1 || true`

If the result above starts with `ASK`, no argument was given: name the target in one `AskUserQuestion`.
- `ASK change <slug>`: options "Approve and build" (first, the default), "Only approve", "Cancel".
- `ASK chart-<N>`: no change is in flight, so ask about the chart: options "Approve chart-<N>" (first), "Cancel". Say what the approval covers, in reading order: for a converted PRD, `prd.md` beside `source.md` and `conversion-review.md`; then `requirements.md`, the intents, the test plan and `chart-review.md`.
- `ASK none ...`: say so in one line and stop.
Then run `SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts approve <target>` as its own Bash call and tell the person its result in one line. After "Approve and build" succeeds, invoke `/rig-build <slug>` with the Skill tool. On Cancel do nothing.

Otherwise tell the person the result above in one line. Do nothing else.
