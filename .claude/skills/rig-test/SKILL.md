---
name: rig:test
description: Verify a built change - every commit and ci sensor, the contracts and the change's own checks - and record verify.json.
argument-hint: '[<slug>]'
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts *), Read, Grep, Glob, Write, Edit
---
# Verify a change

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`.

1. Run `S verify <slug>`. It runs:
   - every commit and ci sensor;
   - the contract commands (validate first);
   - traceability: each B-number in spec.md is named by a test;
   - red-proof: a feature's or bugfix's new tests fail on the base, and a refactor's pass on it.
   It then writes `verify.json` for this tree.
2. On failure, fix the code, never a test, a sensor or a contract, and run verify again. When a finding survives a fix, write in one sentence the premise that fix rested on and check it against the output before the next fix. If the same finding fails twice, stop and show it to the person with that sentence; the person may waive it with `/rig-waive`.
   A test for a test-plan case whose Data column names a file loads that file from the sprint's `testplan/data/`, unchanged, never a copy: a test that inlines the data instead is a failure to fix.
3. On pass, continue with `/rig-pr <slug>` in this turn.
