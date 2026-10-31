---
name: rig:wiki
description: Build and refresh the code wiki - cited, hash-checked pages for engineers, kept in .rig/wiki. Stale pages are a warning, never a gate.
argument-hint: 'init | build [--page <title>] | status | verify | refresh'
allowed-tools: Bash(node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts wiki *), Read, Glob, Grep
---
# Code wiki

`S` means `node --disable-warning=ExperimentalWarning .rig/bin/sdlc.ts`. Run each command as its own Bash call and quote what it prints.

1. **init.** `S wiki init` asks Sonnet to propose `.rig/wiki.json` (pages, purposes, the paths each page is built from) and stops. A person edits it: at most 30 pages, unique titles.
2. **build.** `S wiki build --max-usd <N>` prints an estimate first and writes `.rig/wiki/<page>.md`, `index.md` and `state.json`. Every body line is one sentence ending in a citation such as `[src/a.ts#f]`; a script validates this and a clean-context reviewer drops claims the cited code does not support. Add `--page <title>` to build one page.
3. **status.** `S wiki status` lists pages whose cited code changed, was removed or is declared twice. It writes nothing and always exits 0: stale is a warning.
4. **refresh.** `S wiki refresh --max-usd <N>` rebuilds only the stale pages, with what changed in the brief. Run it on request; `/rig-pr` runs `sync` once per shipped change.
5. **sync.** `S wiki sync --max-usd <N>` is what `/rig-pr` runs before it commits: no `wiki.json` yet means plan and build (no edit step), otherwise refresh. Warn-only.
6. **verify.** `S wiki verify` re-checks every page (citations, then the reviewer); `--no-review` runs the free script checks only.

Never edit a generated page by hand. A wrong or noisy page is a generator problem: fix the cause in the rig repo (this skill, `wikigen.ts`), add a spec that fails without the fix, then rebuild the page.

End with the page count, any page not written and why, the cost, and `Next:` the command the person should run.
