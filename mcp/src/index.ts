import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { RelayClient } from './relay-client';
import { createMcpServer } from './server';

const RELAY_URL = process.env.RELAY_URL ?? 'ws://localhost:9999/agent';

async function main() {
  const relayClient = new RelayClient(RELAY_URL);
  await relayClient.connect();

  const server = createMcpServer(relayClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[agentic-driver-mcp] Fatal error:', error);
  process.exit(1);
});
