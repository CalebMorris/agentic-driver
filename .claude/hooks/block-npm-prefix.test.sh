#!/usr/bin/env bash
# Test suite for .claude/hooks/block-npm-prefix.sh
#
# Usage: bash .claude/hooks/block-npm-prefix.test.sh
# Exit code: 0 if all tests pass, 1 if any fail

HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/block-npm-prefix.sh"
PASS=0
FAIL=0

run_hook() {
  local command="$1"
  printf '{"tool_input":{"command":"%s"}}' "$command" | bash "$HOOK_SCRIPT" 2>/dev/null
}

expect_blocked() {
  local description="$1"
  local command="$2"
  run_hook "$command"
  local exit_code=$?
  if [ "$exit_code" -eq 2 ]; then
    echo "PASS (blocked): $description"
    ((PASS++))
  else
    echo "FAIL (expected blocked/exit-2, got exit-$exit_code): $description"
    ((FAIL++))
  fi
}

expect_allowed() {
  local description="$1"
  local command="$2"
  run_hook "$command"
  local exit_code=$?
  if [ "$exit_code" -eq 0 ]; then
    echo "PASS (allowed): $description"
    ((PASS++))
  else
    echo "FAIL (expected allowed/exit-0, got exit-$exit_code): $description"
    ((FAIL++))
  fi
}

echo "=== block-npm-prefix hook tests ==="
echo ""

# ── Should be blocked ──────────────────────────────────────────────────────────

echo "-- Commands that must be blocked --"

expect_blocked \
  "--prefix . (bare dot, space separator)" \
  "npm run build --prefix ."

expect_blocked \
  "--prefix=. (bare dot, equals separator)" \
  "npm run build --prefix=."

expect_blocked \
  "--prefix . at end of command" \
  "npm install --prefix ."

expect_blocked \
  "--prefix . before the subcommand" \
  "npm --prefix . install"

expect_blocked \
  "--prefix . followed by another flag" \
  "npm run build --prefix . --other-flag"

expect_blocked \
  "--prefix . followed by shell pipe" \
  "npm run build --prefix . | tee out.txt"

expect_blocked \
  "--prefix . followed by semicolon" \
  "npm run build --prefix .; echo done"

# Absolute-path prefixes — these bypass workspace mode just like --prefix .
# and must also be blocked.
expect_blocked \
  "--prefix /absolute/path (absolute path, space separator)" \
  "npm run build --prefix /some/absolute/path"

expect_blocked \
  "--prefix=/absolute/path (absolute path, equals separator)" \
  "npm install pkg --prefix=/some/path"

# This is the exact command that bypassed the hook in production.
expect_blocked \
  "--prefix /absolute/path with 2>&1 redirect (regression: bypassed hook)" \
  "npm run build --prefix /home/cdbitesky/code/agentic-driver_browser-plugin/action-logs/mcp 2>&1"

# ── Should be allowed ──────────────────────────────────────────────────────────

echo ""
echo "-- Commands that must be allowed --"

expect_allowed \
  "workspace -w flag (preferred pattern)" \
  "npm run build -w server"

expect_allowed \
  "--workspaces --if-present (run across all workspaces)" \
  "npm run build --workspaces --if-present"

expect_allowed \
  "npm install with -w flag" \
  "npm install some-package -w mcp"

expect_allowed \
  "plain npm install at root" \
  "npm install"

expect_allowed \
  "--prefix ./subdir (relative subpath, still allowed per hook design)" \
  "npm run build --prefix ./subdir"

expect_allowed \
  "non-npm command with a path argument" \
  "ls /some/absolute/path"

expect_allowed \
  "non-npm command that contains the word prefix" \
  "grep --prefix=foo somefile"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

[ "$FAIL" -eq 0 ]
