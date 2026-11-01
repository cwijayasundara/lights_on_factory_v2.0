"""Gate: no pair of functions with structural similarity >= 0.8."""

import re
import sys

from _gate import ROOT, clear, fail, ok, run, show, targets, tool

clear(".metrics/dry.edn")
result = run([str(tool("dryer")), "--threshold", "0.8", *targets(sys.argv[1:])])
if result.returncode != 0:
    show(result)
    fail(f"dryer exited {result.returncode}")
report = ROOT / ".metrics/dry.edn"
if not report.exists():
    show(result)
    fail("dryer wrote no report (.metrics/dry.edn)")
scores = [float(s) for s in re.findall(r":score\s+([0-9.]+)", report.read_text())]
pairs = [s for s in scores if s >= 0.8]
if pairs:
    print(
        "\n".join(
            line
            for line in result.stdout.splitlines()
            if line.startswith(("DUPLICATE", "  "))
        )
    )
    fail(f"{len(pairs)} duplicate pair(s) at similarity >= 0.8; remove the duplication")
ok("no duplicate pairs at 0.8 or above")
