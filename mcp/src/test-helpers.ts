import pino from 'pino';
import { Writable } from 'stream';

export function createTestLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), lines };
}
