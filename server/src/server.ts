import pino from 'pino';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRelayServer } from './relay';
import { createSigintHandler } from './sigint';

const PORT = 9999;
const LOG_DIR = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'agentic-driver');
const LOG_FILE = path.join(LOG_DIR, 'relay.log');
fs.mkdirSync(LOG_DIR, { recursive: true });

const logger = pino(
  { level: 'info', base: { component: 'relay' } },
  pino.multistream([
    { stream: process.stdout },
    { stream: fs.createWriteStream(LOG_FILE, { flags: 'a' }) },
  ])
);

const { wss, closeGracefully } = createRelayServer(PORT, logger);

wss.on('listening', () => {
  logger.info({ port: PORT }, 'relay_listening');
});

async function shutdown() {
  logger.info('relay_shutdown');
  await closeGracefully();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on(
  'SIGINT',
  createSigintHandler({
    gracefulShutdown: () => void shutdown(),
    panicExit: () => {
      logger.info('relay_panic_exit');
      process.exit(130);
    },
  })
);
