#!/bin/bash
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Block `npm --prefix .` (current directory) and `npm --prefix /abs/path` (absolute
# paths) — both bypass workspace mode and can create stray node_modules /
# package-lock.json outside the workspace.
# Matches: --prefix . followed by end-of-string/whitespace/metacharacter,
#          OR --prefix /... (any absolute path).
# Does NOT match --prefix ./subdir (a legitimate relative subpath).
if echo "$command" | grep -qE 'npm[[:space:]].*--prefix[[:space:]=]+(\.([ \t;|&]|$)|/)'; then
  cat >&2 <<'ERRMSG'
Blocked: `npm --prefix .` and `npm --prefix /abs/path` are not allowed in this npm workspace monorepo.

Use workspace-aware commands instead:
  Target a specific workspace:   npm run <script> -w <workspace>
  Install into a workspace:      npm install <pkg> -w <workspace>
  Run across all workspaces:     npm run <script> --workspaces --if-present
  Reinstall everything:          npm install   (from monorepo root)

See agentic-docs/npm-workspaces.md for full guidance.
ERRMSG
  exit 2
fi

exit 0
