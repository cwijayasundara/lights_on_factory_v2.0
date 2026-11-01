"""Gate: the test suite passes with no skipped tests."""

import xml.etree.ElementTree as ET

from _gate import ROOT, fail, ok, run, show

report = ROOT / "target/junit.xml"
result = run(["uv", "run", "pytest", "-q", f"--junitxml={report}"])
show(result)
if result.returncode != 0:
    fail(f"pytest exited {result.returncode}")
suite = ET.parse(report).getroot()
suite = suite if suite.tag == "testsuite" else suite.find("testsuite")
skipped = int(suite.get("skipped", "0"))
if skipped:
    fail(f"{skipped} skipped test(s); a skipped test proves nothing")
ok(f"{suite.get('tests')} tests, none skipped")
