"""Gate: every function has CRAP < 10 (crapper exits 2 above the threshold)."""

import re
import sys

from _gate import ROOT, clear, config, fail, ok, run, show, targets, tool

clear(".metrics/crap.edn")
result = run([str(tool("crapper")), "--threshold", "9.99", *targets(sys.argv[1:])])
show(result, 30)
if result.returncode != 0:
    fail(
        f"crapper exited {result.returncode}; split or test the functions above CRAP 10"
    )
report = ROOT / ".metrics/crap.edn"
scored = re.findall(r":name\s", report.read_text()) if report.exists() else []
if not scored:
    fail(f"crapper scored no functions under {' '.join(config()['sources'])}")
ok(f"all {len(scored)} functions are under CRAP 10")
