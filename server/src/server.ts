import { createRelayServer } from './relay';

const PORT = 9999;

const { wss, closeGracefully } = createRelayServer(PORT);

wss.on('listening', () => {
  console.log(`[relay] WebSocket relay listening on ws://localhost:${PORT}`);
  console.log('[relay]   Plugin connects at: ws://localhost:9999/plugin');
  console.log('[relay]   Agent connects at:  ws://localhost:9999/agent');
});

async function shutdown() {
  console.log('[relay] Shutting down...');
  await closeGracefully();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
