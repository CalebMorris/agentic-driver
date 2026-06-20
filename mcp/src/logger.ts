import pino from 'pino';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type { Logger } from 'pino';

export const LOG_DIR = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
  'agentic-driver'
);

export function createLogger(logFile: string, component: string) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const streams = [
    { stream: process.stderr },
    { stream: fs.createWriteStream(logFile, { flags: 'a' }) },
  ];
  return pino({ level: 'info', base: { component } }, pino.multistream(streams));
}

export const noopLogger = pino({ level: 'silent' });
