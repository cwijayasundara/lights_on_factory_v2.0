"""Gate: the test suite passes with no skipped tests."""

import xml.etree.ElementTree as ET

from _gate import ROOT, fail, ok, run, show

# Configuration that silently removes tests from the run. The gate refuses it outright.
DROPS_TESTS = (
    "collect_ignore",
    "pytest_collection_modifyitems",
    "--deselect",
    "--ignore",
)
for config_file in [ROOT / "pyproject.toml", *ROOT.glob("**/conftest.py")]:
    if ".venv" in config_file.parts or not config_file.exists():
        continue
    if any(marker in config_file.read_text() for marker in DROPS_TESTS):
        fail(
            f"{config_file.relative_to(ROOT)} configures pytest to drop tests; remove that and fix the tests instead"
        )

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
