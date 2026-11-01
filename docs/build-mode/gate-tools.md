# Build-mode gate tools: probe evidence

Date: 2026-11-01. Machine: macOS, Python 3.14.0 as `python3`, uv 0.8.13. The probe project was a throwaway uv project (Python 3.12 target) with one planted violation of each kind.

## Pins

| Tool | Commit | License |
| --- | --- | --- |
| [unclebob/crapper](https://github.com/unclebob/crapper) | `6fd92c4c9bcc56efb64a2f8743d5a2993bcfd42d` | 0BSD |
| [unclebob/dryer](https://github.com/unclebob/dryer) | `66ff6d21a42c04afcad89c78a80066176d1294b0` | 0BSD |
| [unclebob/mutator](https://github.com/unclebob/mutator) | `a5a0cb803b66e0cdb8bf471b3b08af701d424a41` | 0BSD |

All three work on Python, so no tool was swapped.

## How the tools behave

- **They are not installable as uv tools.** Each runs from its own checkout (`./crapper`, `./dryer`, `./mutator`) and creates a private `.venv` with the host `python3` (3.11 or newer) on first run. mutator also needs crapper checked out beside it (`../crapper`). The wrappers therefore clone all three at their pins into one directory, `${LIGHTS_ON_TOOLS:-~/.cache/lights-on/gate-tools}/<crapper7>-<dryer7>-<mutator7>/`, and refuse a checkout that is not at its pin.
- **They walk the whole tree,** so they would also score `.factory/gates/*.py`. The wrappers scope every run to `build.json` `sources` (`["src"]`) unless paths are given.
- **crapper** runs pytest under `coverage.py`, writes `target/coverage/python/lcov.info` and `.metrics/crap.edn`, and exits 2 when the worst score is above `--threshold`. The wrapper passes `--threshold 9.99` for "CRAP < 10". Planted: a six-branch `grade` with one test → CRAP 33.7, exit 2.
- **dryer** exits 0 after any report. The wrapper reads `.metrics/dry.edn` and fails on any `:score` ≥ 0.8. Planted: two same-shape functions → score 1.00.
- **mutator** exits 0 when all executed mutants die, 2 when the baseline tests fail, 3 when a mutant survives. It prints `UNCOVERED` sites without failing on them. The wrapper fails on any `SURVIVED` or `UNCOVERED` line that is not in `.factory/accepted-mutants.md`, matching ub-mode's "cover the uncovered". Planted: 5 uncovered and 4 survivors.

## Wrapper results

| Gate | Violating project | Fixed project |
| --- | --- | --- |
| `tests.py` | an `@pytest.mark.skip` test → `FAIL: 1 skipped test(s)` | `PASS: 3 tests, none skipped` |
| `crap.py` | exit 1, `CRAP threshold exceeded: 33.7 > 10.0` | `PASS: every function is under CRAP 10` |
| `dry.py` | exit 1, `1 duplicate pair(s)` | `PASS: no duplicate pairs at 0.8 or above` |
| `mutate.py` | exit 1, `9 mutant(s) survived or are uncovered` | one genuinely equivalent survivor (`i > 0` → `i >= 0` before doubling and summing) accepted with a reason → `PASS: every mutant killed (1 accepted)` |
| lint (`ruff check src tests && ruff format --check src tests`) | unformatted test file → exit 1 | exit 0 |
| types (`mypy --strict src`) | — | `Success: no issues found` |

Scoping lint to `src tests` keeps the operator-owned `.factory/gates/` out of the agent's lint gate.

## Isolation

Recorded by Task 7.
