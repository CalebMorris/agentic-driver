export const DEFAULT_PANIC_WINDOW_MS = 1000;

export interface SigintHandlerOptions {
  gracefulShutdown: () => void;
  panicExit: () => void;
  panicWindowMs?: number;
  now?: () => number;
}

export function createSigintHandler(options: SigintHandlerOptions): () => void {
  const panicWindowMs = options.panicWindowMs ?? DEFAULT_PANIC_WINDOW_MS;
  const now = options.now ?? Date.now;
  let lastSigintAt: number | null = null;

  return () => {
    const timestamp = now();
    if (lastSigintAt !== null && timestamp - lastSigintAt <= panicWindowMs) {
      options.panicExit();
      return;
    }
    lastSigintAt = timestamp;
    options.gracefulShutdown();
  };
}
