#!/bin/bash
# Idempotent toolchain check for a native Claude cloud environment.
# Node 22 is preinstalled on Anthropic-hosted VMs; Rig's hooks need >= 22.18.
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "rig cloud profile: Node.js >= 22.18 is not on PATH" >&2
  exit 1
fi

found=$(node --version)
ver=${found#v}
major=${ver%%.*}
rest=${ver#*.}
minor=${rest%%.*}
if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }; then
  exit 0
fi

echo "rig cloud profile: Node.js >= 22.18 is required (found ${found})" >&2
exit 1
