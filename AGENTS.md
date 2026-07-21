# Agentic Driver — Agent Notes

Reference these docs before working in the relevant areas:

- [Markdown Writing Guidelines](agentic-docs/markdown-writing.md) — rules for writing markdown docs in this project
- [MV3 Background Service Worker Pitfalls](agentic-docs/mv3-background-service-worker.md) — gotchas for `background.js` (MV3 service worker)
- [Playwright + Chrome Extension Testing](agentic-docs/playwright-chrome-extensions.md) — pitfalls and correct patterns for Playwright e2e tests
- [MCP Adapter](agentic-docs/mcp-adapter.md) — pitfalls and patterns for the `/mcp` package (MCP server, zod v4, in-process testing)
- [Relay Server](agentic-docs/relay-server.md) — pitfalls and patterns for `server/src/relay.ts` (state machine, multi-step protocol, suppression, disconnect handling)
- [npm Workspaces](agentic-docs/npm-workspaces.md) — workspace structure, hoisting, shared devDeps, tsconfig inheritance, canonical layout

## Log Locations

Runtime logs are NOT in the repo. They live in `$XDG_STATE_HOME/agentic-driver/` (default: `~/.local/state/agentic-driver/`):

- `relay.log` — relay server (pino JSON lines). Also receives plugin logs: the extension mirrors its console output to the relay as `log` control messages, which the relay writes here without forwarding to the agent.
- `mcp.log` — MCP server (pino JSON lines), including relay-client send/receive entries with request IDs, error codes, and durations.

To debug a failed tool call or extension error, read these files first — do not search the repo, `/tmp`, or a `logs/` directory for log output.

## MCP Registration Scope

The `install:mcp` script must register with `claude mcp add -s user` (user scope). Local scope (`-s local`) confines the server to this repo's directory, and sessions in other repos won't see the tools — the whole point is driving the browser from anywhere.

## Maintenance Rule — MCP Tools → Drive Skill

**Any time `mcp/src/server.ts` is changed** (tool added, removed, renamed, or its behaviour/error codes changed), **update `skills/drive/SKILL.md`** to match:

- New tool → add a subsection under "Available Tools" with signature, response shape, and error guidance.
- Removed tool → remove its subsection and any references in the driving loop or error table.
- Renamed tool → update all references throughout the skill (description frontmatter, Section 1, Section 2 tool entry, error table).
- Behaviour / error code change → update the relevant tool entry and the error handling reference table.

The skill is what agents read at runtime. A stale skill causes agents to call wrong tool names, miss new tools, or follow outdated recovery steps.
