import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import * as fs from 'fs';
import { RelayClient } from './relay-client';
import { createMcpServer } from './server';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:9999/agent';
const LOG_FILE = '/tmp/agentic-driver-mcp.log';

function log(message: string) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  process.stderr.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

async function main() {
  log(`Starting — relay URL: ${RELAY_URL}`);

  const relayClient = new RelayClient(RELAY_URL);
  const server = createMcpServer(relayClient);
  const transport = new StdioServerTransport();

  // Connect to stdio first so Claude Code's handshake completes immediately.
  // The relay connection happens in the background; tool calls will return an
  // error if the relay isn't up yet.
  log('Connecting MCP server to stdio transport...');
  await server.connect(transport);
  log('MCP server ready — connecting to relay in background');

  relayClient.connect().then(() => {
    log('Relay connected');
  }).catch((error: unknown) => {
    log(`Relay connection failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
