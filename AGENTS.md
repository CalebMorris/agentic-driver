# Agentic Driver — Agent Notes

Reference these docs before working in the relevant areas:

- [Markdown Writing Guidelines](agentic-docs/markdown-writing.md) — rules for writing markdown docs in this project
- [MV3 Background Service Worker Pitfalls](agentic-docs/mv3-background-service-worker.md) — gotchas for `background.js` (MV3 service worker)
- [Playwright + Chrome Extension Testing](agentic-docs/playwright-chrome-extensions.md) — pitfalls and correct patterns for Playwright e2e tests
- [MCP Adapter](agentic-docs/mcp-adapter.md) — pitfalls and patterns for the `/mcp` package (MCP server, zod v4, in-process testing)
- [Relay Server](agentic-docs/relay-server.md) — pitfalls and patterns for `server/src/relay.ts` (state machine, multi-step protocol, suppression, disconnect handling)
- [npm Workspaces](agentic-docs/npm-workspaces.md) — workspace structure, hoisting, shared devDeps, tsconfig inheritance, canonical layout

## Maintenance Rule — MCP Tools → Drive Skill

**Any time `mcp/src/server.ts` is changed** (tool added, removed, renamed, or its behaviour/error codes changed), **update `skills/drive/SKILL.md`** to match:

- New tool → add a subsection under "Available Tools" with signature, response shape, and error guidance.
- Removed tool → remove its subsection and any references in the driving loop or error table.
- Renamed tool → update all references throughout the skill (description frontmatter, Section 1, Section 2 tool entry, error table).
- Behaviour / error code change → update the relevant tool entry and the error handling reference table.

The skill is what agents read at runtime. A stale skill causes agents to call wrong tool names, miss new tools, or follow outdated recovery steps.
