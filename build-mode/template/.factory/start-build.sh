#!/bin/sh
# Start or resume an unattended build-mode session. Run from anywhere inside the target repository.
set -eu
cd "$(git rev-parse --show-toplevel)"
if grep -qx 'config-dir' .factory/isolation 2>/dev/null; then
  export CLAUDE_CONFIG_DIR="${LIGHTS_ON_CONFIG_DIR:-$HOME/.claude-build}"
fi
exec claude --setting-sources project --permission-mode auto "$(cat .factory/build-prompt.txt)"
