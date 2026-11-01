"""Shared helpers for build-mode gate wrappers. Every gate exits 0 only on pass."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path.cwd()
TOOLS = ("crapper", "dryer", "mutator")


def config() -> dict:
    return json.loads((ROOT / ".factory/build.json").read_text())


def tool(name: str) -> Path:
    """Path to a pinned unclebob gate tool's launcher, cloning the pins on first use.

    mutator needs crapper checked out beside it, so all three share one directory per pin set.
    LIGHTS_ON_TOOL_<NAME> points at a launcher directly, for tests and local tool checkouts.
    """
    override = os.environ.get(f"LIGHTS_ON_TOOL_{name.upper()}")
    if override:
        return Path(override)
    pins = config()["tools"]
    home = Path(
        os.environ.get("LIGHTS_ON_TOOLS", Path.home() / ".cache/lights-on/gate-tools")
    )
    base = home / "-".join(pins[t][:7] for t in TOOLS)
    for each in TOOLS:
        checkout = base / each
        if not (checkout / ".git").exists():
            base.mkdir(parents=True, exist_ok=True)
            run(
                [
                    "git",
                    "clone",
                    "-q",
                    f"https://github.com/unclebob/{each}",
                    str(checkout),
                ],
                must=True,
            )
            run(["git", "-C", str(checkout), "checkout", "-q", pins[each]], must=True)
        head = run(
            ["git", "-C", str(checkout), "rev-parse", "HEAD"], must=True
        ).stdout.strip()
        if head != pins[each]:
            fail(
                f"{checkout} is at {head}, expected the pin {pins[each]}; delete it and rerun"
            )
    return base / name / name


def targets(argv: list[str]) -> list[str]:
    """The arguments for a tool, scoped to build.json "sources" unless paths were given."""
    paths = [a for a in argv if not a.startswith("-")]
    return argv if paths else [*argv, *config()["sources"]]


def clear(*relative: str) -> None:
    """Remove earlier tool output so a stale report can never pass a gate."""
    for item in relative:
        path = ROOT / item
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()


def run(cmd: list[str], must: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, check=False, cwd=ROOT, text=True, capture_output=True)
    if must and result.returncode != 0:
        show(result)
        fail(f"{' '.join(cmd)} exited {result.returncode}")
    return result


def show(result: subprocess.CompletedProcess, lines: int = 40) -> None:
    out = (result.stdout + result.stderr).strip().splitlines()
    print("\n".join(out[-lines:]))


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def ok(message: str) -> None:
    print(f"PASS: {message}")
    sys.exit(0)
