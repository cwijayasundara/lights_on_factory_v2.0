---
name: rig:autonomy
description: Human only. Show the autonomy rung and its evidence-based proposal, or set it with `set <0|1|2|3> --why "<text>"`. The model cannot run this.
argument-hint: [set <0|1|2|3> --why "<text>"]
disable-model-invocation: true
allowed-tools: Bash(SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts autonomy *)
---
!`SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts autonomy $ARGUMENTS 2>&1 || true`

Tell the person the result above in one line. Do nothing else.
