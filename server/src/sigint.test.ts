import { describe, it, expect, vi } from 'vitest';
import { createSigintHandler, DEFAULT_PANIC_WINDOW_MS } from './sigint';

function createHandler(now: () => number) {
  const gracefulShutdown = vi.fn();
  const panicExit = vi.fn();
  const handler = createSigintHandler({ gracefulShutdown, panicExit, now });
  return { handler, gracefulShutdown, panicExit };
}

describe('createSigintHandler', () => {
  it('starts a graceful shutdown on the first SIGINT', () => {
    const { handler, gracefulShutdown, panicExit } = createHandler(() => 0);

    handler();

    expect(gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(panicExit).not.toHaveBeenCalled();
  });

  it('panic-exits on a second SIGINT within the panic window', () => {
    let clock = 0;
    const { handler, gracefulShutdown, panicExit } = createHandler(() => clock);

    handler();
    clock = DEFAULT_PANIC_WINDOW_MS - 1;
    handler();

    expect(panicExit).toHaveBeenCalledTimes(1);
    expect(gracefulShutdown).toHaveBeenCalledTimes(1);
  });

  it('does not panic when the second SIGINT arrives after the panic window', () => {
    let clock = 0;
    const { handler, gracefulShutdown, panicExit } = createHandler(() => clock);

    handler();
    clock = DEFAULT_PANIC_WINDOW_MS + 1;
    handler();

    expect(panicExit).not.toHaveBeenCalled();
    expect(gracefulShutdown).toHaveBeenCalledTimes(2);
  });

  it('panics when two presses are close together even after an earlier slow press', () => {
    let clock = 0;
    const { handler, panicExit } = createHandler(() => clock);

    handler();
    clock = DEFAULT_PANIC_WINDOW_MS * 3;
    handler();
    clock += DEFAULT_PANIC_WINDOW_MS - 1;
    handler();

    expect(panicExit).toHaveBeenCalledTimes(1);
  });
});
