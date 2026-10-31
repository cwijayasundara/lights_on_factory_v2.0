---
name: rig:waive
description: Human only. Waive a sensor finding for the active change, or a chart review finding (chart-N). The model cannot run this.
argument-hint: <sensor-or-command-id> <file|*> <reason> [--days N] | chart-<N> <finding number> <reason>
disable-model-invocation: true
allowed-tools: Bash(SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts waive *)
---
!`SDLC_HUMAN=1 node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts waive '$ARGUMENTS' 2>&1 || true`

Tell the person the result above in one line. Do nothing else.
