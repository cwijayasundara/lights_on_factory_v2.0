"""Gate: the acceptance suite in acceptance/ passes, runs at least one test, and skips none."""

import xml.etree.ElementTree as ET

from _gate import ROOT, clear, fail, ok, run, show

if not (ROOT / "acceptance").is_dir():
    fail("acceptance/ is missing; the acceptance suite is required")

report = ROOT / "target/acceptance.xml"
clear("target/acceptance.xml")
result = run(
    [
        "uv",
        "run",
        "python",
        "-B",
        "-m",
        "pytest",
        "acceptance",
        "-q",
        "-p",
        "no:cacheprovider",
        f"--junitxml={report}",
    ]
)
show(result)
if result.returncode != 0:
    fail(f"acceptance suite exited {result.returncode}")
if not report.exists():
    fail("pytest wrote no report")
suite = ET.parse(report).getroot()
suite = suite if suite.tag == "testsuite" else suite.find("testsuite")
tests = int(suite.get("tests", "0"))
skipped = int(suite.get("skipped", "0"))
if tests == 0:
    fail("the acceptance suite ran no tests")
if skipped:
    fail(f"{skipped} skipped acceptance test(s); a skipped check proves nothing")
ok(f"{tests} acceptance tests, none skipped")
