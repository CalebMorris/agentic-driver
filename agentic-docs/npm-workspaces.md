# npm Workspaces — Pitfalls and Canonical Structure

Gotchas and correct patterns for this monorepo's npm workspace setup. Each section is self-contained.

| § | Symptom / Topic |
|---|---------|
| 1 | Workspace package has its own `package-lock.json` |
| 2 | `npm run build --workspaces` fails when a workspace lacks the script |
| 3 | Shared devDependencies duplicated across workspace `package.json` files |
| 4 | `tsconfig.json` duplicated verbatim across workspaces |
| 5 | Running `npm install` inside a workspace subdirectory |
| 6 | Canonical workspace structure (reference) |


## 1. Only one `package-lock.json` — at the root

**Trap:** Workspace packages (`server/`, `mcp/`) have their own `package-lock.json`. npm workspace mode manages a single lock file at the monorepo root. Subdirectory lock files are stale, conflict with hoisting, and confuse `npm ci`.

**Fix:** Delete any `package-lock.json` inside workspace subdirectories. There must be exactly one, at the monorepo root.

```
agentic-driver/
  package-lock.json   ← only one
  server/
    package.json      ← no package-lock.json here
  mcp/
    package.json      ← no package-lock.json here
```


## 2. `--if-present` is required for workspace script loops

**Trap:** `npm run build --workspaces` (without `--if-present`) fails with `Missing script: "build"` if any workspace doesn't define that script. This breaks CI builds and `npm run test --workspaces` if a workspace has no tests.

**Fix:** Always pair `--workspaces` with `--if-present` in root scripts.

```json
// root package.json — CORRECT
{
  "scripts": {
    "build": "npm run build --workspaces --if-present",
    "test":  "npm run test  --workspaces --if-present"
  }
}
```

To target a single workspace, use `-w`:
```bash
npm run dev -w server
npm run test:e2e -w server
```


## 3. Hoist shared devDependencies to the root

**Trap:** Both `mcp/package.json` and `server/package.json` declare the same devDependencies (`typescript`, `vitest`, `@types/node`, `@types/ws`). npm may install duplicate copies, versions drift independently, and there is no single place to update them.

**Fix:** Move dev tools used across all workspaces to `devDependencies` in the root `package.json`. Workspace packages keep only devDeps that are unique to them.

```json
// root package.json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws":   "^8.5.14",
    "typescript":  "^5.7.0",
    "vitest":      "^2.0.0"
  }
}

// mcp/package.json — no devDependencies at all (all shared)
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ws":  "^8.18.0",
    "zod": "^4.4.3"
  }
}

// server/package.json — only workspace-unique devDeps remain
{
  "dependencies": { "ws": "^8.18.0" },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "ts-node-dev":      "^2.0.0"
  }
}
```

**Rule:** Runtime deps stay in the workspace that needs them. Dev tooling shared by two or more workspaces belongs at the root.


## 4. Extract a root `tsconfig.base.json`; workspaces extend it

**Trap:** Both `mcp/tsconfig.json` and `server/tsconfig.json` are identical. Any change (e.g., bumping `target`) must be applied twice and can silently diverge.

**Fix:** Create `tsconfig.base.json` at the monorepo root with the shared `compilerOptions`. Each workspace `tsconfig.json` extends it and only declares what is workspace-specific.

```json
// tsconfig.base.json (root)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}

// mcp/tsconfig.json  (and server/tsconfig.json — identical shape)
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```


## 5. Always run `npm install` from the monorepo root

**Trap:** Running `npm install <pkg>` inside `server/` or `mcp/` creates or updates a local `node_modules/` and may add a local `package-lock.json`, breaking workspace hoisting.

**Fix:** All installs must run from the root. Use `-w` to target a specific workspace's `package.json`.

```bash
# Add a dep to a specific workspace
npm install ws -w server

# Add a devDep to root (shared across all workspaces)
npm install -D typescript

# Install everything (run after any package.json change)
npm install
```

Never `cd server && npm install`.


## 6. Canonical workspace structure (reference)

This is the correct state of the monorepo. Use it to quickly verify that any change you make is consistent.

```
agentic-driver/                  ← monorepo root
  package.json                   ← workspaces: ["server","mcp"], shared devDeps, engines
  package-lock.json              ← single lock file
  tsconfig.base.json             ← shared compilerOptions; workspaces extend this
  node_modules/                  ← all hoisted deps land here
    agentic-driver-mcp  → ../mcp       (symlink)
    agentic-driver-server → ../server  (symlink)
    ...everything else...

  mcp/
    package.json                 ← runtime deps only; no devDeps (all shared)
    tsconfig.json                ← extends ../tsconfig.base.json
    src/
    dist/

  server/
    package.json                 ← runtime deps + workspace-unique devDeps
    tsconfig.json                ← extends ../tsconfig.base.json
    src/
    dist/

  plugin/                        ← plain MV3 extension; no package.json, not a workspace
    manifest.json
    background.js
    popup.html / popup.js
```

**Root `package.json` checklist:**
- `"private": true` — prevents accidental publish of the root
- `"engines": {"node": ">=18"}` — MCP SDK requires ≥18; set once at root
- `"workspaces": ["server", "mcp"]`
- All root scripts use `--if-present` when targeting `--workspaces`
