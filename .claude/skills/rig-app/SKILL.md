---
name: rig:app
description: Make this repo's running app verifiable - write a driver that launches the real app and walks its main journeys, plus a short feature map, so verify, ship and CI catch what unit tests miss. Use when a repo has no journeys, or when the app changed in a way the journeys no longer describe.
argument-hint: '[<app name>]'
effort: medium
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts app init), Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts app run *), Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts app status*), Read, Grep, Glob, Write, Edit, AskUserQuestion
---
# Journeys: $ARGUMENTS

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`. A journey is what a person does with the app and what must be true afterwards. Nothing here assumes what kind of app it is: the driver is any command that exits 0 when every journey held and 1 when one did not.

1. Run `S app init` (it installs the optional Node helper `.rig/verify/lib.mjs`) and `S app status`. Read the README, the run scripts, the routes or screens, and `.rig/wiki` when it exists, to learn how the app starts and what a user does with it.
2. Propose 3 to 5 journeys, the ones whose failure a user would notice first, and ask the person to confirm them in one `AskUserQuestion` batch (at most 4 questions). Never invent an expected outcome; ask.
3. Write, under `.rig/verify/<app>/`:
   - `app.json`: `{ "run": "<the command that runs the driver>", "files": ["<driver file>"] }`.
   - the driver. For an HTTP service or a command-line program use the Node helper: `import { verify } from '../lib.mjs'`, `launch('<start command>')` (it sets `PORT=0` and reads the port from a `listening on <port>` line; pass `ready:` for another line), then `step(name, fn)` per check. For a UI use what the repo already has (Playwright, Cypress) or ask before adding a dev dependency; prefer ARIA roles and data attributes over coordinates. Any language works if it meets the same contract: exit 0 or 1, and write `$RIG_VERIFY_STATE/evidence.json` as `{ "ok": true, "steps": [{ "name": "...", "ok": true }] }` with at least one step (the helper does this); an exit 0 with no evidence counts as a failed run.
   - `features/<feature>.md`, one per feature, seeded with each journey: `entry: <a source path>` lines (the check fails when one no longer exists), how a user reaches it, the observable end state, and the side effects to check (rows, files, messages).
4. Hold to these rules in the driver: assert the end state, and the side effects, never only a status code; stop only what it started, never by process name; do not weaken a journey to make it pass.
5. Run it with `S app run <app>`. Fix the driver or report a real app bug to the person. A driver that has never run is a draft, and a draft is not enforced.
6. Hand over: tell the person to review the files and run `! SDLC_HUMAN=1 node .rig/bin/sdlc.ts app approve <app>` (the path of the script you ran, when the harness is not vendored). Approval runs the driver once more and records its hash; verify, ship and CI then run it. A later edit to the driver or the map shows as a warning in the PR until it is approved again.

End with: `Next: review and approve the journeys (you), then /rig-start for the next change`.
