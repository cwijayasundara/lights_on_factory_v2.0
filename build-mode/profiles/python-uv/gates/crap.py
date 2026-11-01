"""Gate: every function has CRAP < 10 (crapper exits 2 above the threshold)."""

import sys

from _gate import fail, ok, run, show, targets, tool

result = run([str(tool("crapper")), "--threshold", "9.99", *targets(sys.argv[1:])])
show(result, 30)
if result.returncode != 0:
    fail(
        f"crapper exited {result.returncode}; split or test the functions above CRAP 10"
    )
ok("every function is under CRAP 10")
