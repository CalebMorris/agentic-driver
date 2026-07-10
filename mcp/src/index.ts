import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { createLogger, LOG_DIR } from './logger';
import { RelayClient } from './relay-client';
import { createMcpServer } from './server';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:9999/agent';
import * as path from 'path';

const LOG_FILE = path.join(LOG_DIR, 'mcp.log');

const logger = createLogger(LOG_FILE, 'mcp');

async function main() {
  logger.info({ relayUrl: RELAY_URL }, 'startup');

  const relayClient = new RelayClient(RELAY_URL, { logger });
  const server = createMcpServer(relayClient, logger);
  const transport = new StdioServerTransport();

  // Connect to stdio first so Claude Code's handshake completes immediately.
  // The relay connection happens in the background; tool calls will return an
  // error if the relay isn't up yet.
  logger.info('mcp_connecting');
  await server.connect(transport);
  logger.info('mcp_ready');

  relayClient.connect().catch((error: unknown) => {
    logger.error({ message: error instanceof Error ? error.message : String(error) }, 'relay_connect_failed');
  });
}

main().catch((error) => {
  logger.error({ message: error instanceof Error ? error.stack ?? error.message : String(error) }, 'fatal');
  process.exit(1);
});
