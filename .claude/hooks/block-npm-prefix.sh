#!/bin/bash
set -euo pipefail

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Block `npm --prefix .` — dot means current directory, which bypasses workspace
# mode and can create stray node_modules / package-lock.json inside a workspace.
# Matches: --prefix . or --prefix=. followed by end-of-string, whitespace, or a
# shell metacharacter. Does NOT match --prefix ./subdir (a legitimate subpath).
if echo "$command" | grep -qE 'npm[[:space:]].*--prefix[[:space:]=]+\.([ \t;|&]|$)'; then
  cat >&2 <<'ERRMSG'
Blocked: `npm --prefix .` is not allowed in this npm workspace monorepo.

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
