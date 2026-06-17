#!/usr/bin/env node
// Fixes @modelcontextprotocol/sdk wildcard exports for Node.js strict package exports.
//
// Node.js does NOT apply CJS extension resolution (.js fallback) for wildcard export
// targets. The SDK ships "require": "./dist/cjs/*" which resolves to e.g.
// "./dist/cjs/server/stdio" — an exact path that doesn't exist (only stdio.js does).
//
// Adding .js to the wildcard target makes the resolved path exact: "./dist/cjs/server/stdio.js".
// See: https://nodejs.org/api/packages.html#subpath-patterns

const fs = require('fs');
const path = require('path');

const sdkPkgPath = path.resolve(__dirname, '../node_modules/@modelcontextprotocol/sdk/package.json');

if (!fs.existsSync(sdkPkgPath)) {
  console.log('patch-mcp-sdk: @modelcontextprotocol/sdk not found, skipping');
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(sdkPkgPath, 'utf-8'));
const wildcard = pkg.exports?.['./*'];

if (!wildcard) {
  console.log('patch-mcp-sdk: ./* export not found, skipping');
  process.exit(0);
}

if (wildcard.require === './dist/cjs/*.js') {
  console.log('patch-mcp-sdk: already patched, skipping');
  process.exit(0);
}

wildcard.require = './dist/cjs/*.js';
wildcard.import = './dist/esm/*.js';

fs.writeFileSync(sdkPkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('patch-mcp-sdk: patched @modelcontextprotocol/sdk wildcard exports');
