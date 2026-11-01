# Experiment 3: does build mode take a spec to a working project with zero interventions?

Status: ready to run. Not yet observed.

## Question

Given only an approved `SPEC.md` and the build-mode install, does one local Claude Code session build [cwijayasundara/mini-agent-kit](https://github.com/cwijayasundara/mini-agent-kit) to `COMPLETE` without anyone touching it after the start command?

## Setup

- Repo: `cwijayasundara/mini-agent-kit` (public), `main` at `57a3416 chore: install build mode`. It holds `SPEC.md` (from `examples/mini-agent-kit/SPEC.md`), a README, `.gitignore` and the build-mode install.
- Isolation: `--setting-sources project` (proved in `docs/build-mode/gate-tools.md`).
- Gate tools are cloned at their pins into `~/.cache/lights-on/gate-tools/` on the first gate run.

## Run

In your own terminal:
```
cd ~/Documents/learning_102/mini-agent-kit && .factory/start-build.sh
```
Accept the one-time workspace trust dialog if it appears. Then don't touch it. Watch commits at https://github.com/cwijayasundara/mini-agent-kit/commits/main if you like. If the session dies, rerun the same command; it resumes from what is on disk.

## Pass criteria

| Measure | Pass |
| --- | --- |
| Human interventions after the start command (the trust dialog excepted) | 0 |
| Report header | `COMPLETE` |
| Gates at the end, re-run by the operator | all pass |
| Demo, run by the operator | `uv run mini-agent demo` prints the spec's four lines |
| Protected-file violations caught | any number is fine if the run recovered on its own |
| Decisions | each is sensible on a read-through |

## Results

| Measure | Observed |
| --- | --- |
| Interventions | |
| Report header | |
| Gates re-run | |
| Demo | |
| Hook blocks (from `.factory/hook-log.jsonl`) | |
| Decisions / blocked tasks | |
| Wall time | |

Date:

## Decide

- **COMPLETE with zero interventions:** build mode works for a small greenfield project. Next: run it in a cloud session with the same files.
- **PARTIAL or STALLED:** read `BLOCKED.md` and `hook-log.jsonl`. Fix the skill or the hook for what stopped it, not the spec.
- **Stopped for input anyway:** note exactly what asked and why. That's a hole in the isolation, the permissions or the skill's no-questions rule.
