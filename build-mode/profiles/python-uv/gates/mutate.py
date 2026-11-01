"""Gate: no surviving or uncovered mutants, except those accepted with a reason.

Accepted mutants live in .factory/accepted-mutants.md, one per line:
- <file>:<line> <from> -> <to> — <why it is equivalent>
"""

import re
import sys

from _gate import ROOT, config, fail, ok, run, show, targets, tool

OUTCOME = re.compile(r"^(SURVIVED|UNCOVERED)\s+(\S+:\d+ .+?)\s*$")


def accepted() -> set[str]:
    path = ROOT / config()["acceptedMutants"]
    if not path.exists():
        return set()
    entries = set()
    for line in path.read_text().splitlines():
        match = re.match(r"^- (\S+:\d+ .+?) — \S", line)
        if match:
            entries.add(match.group(1).strip())
    return entries


allowed = accepted()
limit = config()["limits"]["maxAcceptedMutants"]
if len(allowed) > limit:
    fail(f"{len(allowed)} accepted mutants, more than the limit of {limit}")
result = run([str(tool("mutator")), *targets(sys.argv[1:])])
if result.returncode == 2:
    show(result)
    fail("the baseline tests fail, so no mutant ran")
bad = []
for line in result.stdout.splitlines():
    match = OUTCOME.match(line)
    if match and match.group(2) not in allowed:
        bad.append(line)
if result.returncode not in (0, 3):
    show(result)
    fail(f"mutator exited {result.returncode}")
if bad:
    print("\n".join(bad))
    fail(
        f"{len(bad)} mutant(s) survived or are uncovered; test them, delete dead code, or accept an equivalent one with a reason"
    )
ok(f"every mutant killed ({len(allowed)} accepted)")
