#!/bin/sh
# Production gate (playbook p.41), a managed-only PreToolUse hook on Bash: install it root-owned outside any repo and wire it in managed settings.
# A command naming deploy and the production environment needs RELEASE_APPROVAL, else exit 2 with the route. A text match: leaky by design,
# acceptable because managed settings make it impossible to switch off. No jq or node needed. Logs only matching commands, never their text.
input=$(cat)
# Every "command" value in the input, still JSON-escaped; if none is found, match the whole input (blocks more, never less).
cmd=$(printf '%s' "$input" | grep -oE '"command"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"')
[ -n "$cmd" ] || cmd=$input
# The text is still JSON-escaped: a newline or tab inside the command is the two characters \n or \t, and an escaped quote is \". Read them as spaces, or a
# newline between DROP and TABLE (or git push and --force) would slip past the patterns below.
cmd=$(printf '%s' "$cmd" | sed -e 's/\\n/ /g' -e 's/\\t/ /g' -e 's/\\r/ /g' -e 's/\\"/ /g')
env_name=${RIG_PRODUCTION_ENV:-production}
# What pauses for a person (guides/irreversible.md): a deploy to production, a force-push, dropping data. Reversible work never reaches this.
if printf '%s' "$cmd" | grep -qiF deploy && printf '%s' "$cmd" | grep -qiF -- "$env_name"; then
  what="deploying to $env_name"
elif printf '%s' "$cmd" | grep -qiE 'git[^;&|]*[[:space:]]push[^"]*([[:space:]]--force|[[:space:]]-[A-Za-z]*f[A-Za-z]*([^[:alnum:]-]|$)|[[:space:]]--mirror|[[:space:]]--delete|[[:space:]]\+[[:alnum:]_./-])'; then
  what="force-pushing, which rewrites history others rely on,"
# SQL that drops data, run through a database client: a grep, cat or echo that only mentions the words is not the act.
elif printf '%s' "$cmd" | grep -qiE 'drop[[:space:]]+(table|database|schema)|truncate[[:space:]]+table' && printf '%s' "$cmd" | grep -qiE 'psql|mysql|mariadb|sqlite3?|sqlcmd|mongosh|sqlplus|duckdb|snowsql|clickhouse|cockroach|usql|pgcli|mycli|prisma|knex|rails db|manage\.py|alembic|flyway|liquibase'; then
  what="dropping data, which cannot be undone,"
else
  exit 0
fi
if [ -n "$RELEASE_APPROVAL" ]; then decision=allow; else decision=block; fi
session=$(printf '%s' "$input" | sed -nE 's/.*"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9-]*)".*/\1/p')
dir=${CLAUDE_PROJECT_DIR:-$PWD}/.rig
if [ -d "$dir" ] && [ ! -L "$dir/gates.jsonl" ]; then
  { printf '{"at":"%s","decision":"%s","session":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$decision" "$session" >> "$dir/gates.jsonl"; } 2>/dev/null || :
fi
[ "$decision" = allow ] && exit 0
echo "Blocked: $what needs a release manager's approval. Prepare the release, ask the release manager to authorize it, and resume this session with the approved change ticket: RELEASE_APPROVAL=<ticket> claude --resume." >&2
exit 2
