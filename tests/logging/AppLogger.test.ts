import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppLogger, parseLogLevel } from '../../src/logging/AppLogger.js';

describe('AppLogger', () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterAll(() => {
    if (originalLevel === undefined) {
      delete process.env.LOG_LEVEL;
      return;
    }
    process.env.LOG_LEVEL = originalLevel;
  });

  it('defaults to info for missing or invalid log levels', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('verbose')).toBe('info');
  });

  it('parses supported log levels case-insensitively', () => {
    expect(parseLogLevel('error')).toBe('error');
    expect(parseLogLevel('INFO')).toBe('info');
    expect(parseLogLevel('Debug')).toBe('debug');
  });

  it('suppresses info and debug logs at error level', () => {
    const sink = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const logger = createAppLogger({
      level: 'error',
      sink,
      clock: () => new Date('2026-06-03T12:34:56.000Z'),
    });

    logger.info('startup.ready', { projects: 1 });
    logger.debug('gateway.started', { mode: 'debug' });
    logger.error('session.send_failed', { session: 'sess_1' });

    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledWith(
      '[2026-06-03 12:34:56] ERROR session.send_failed session=sess_1',
    );
  });

  it('prints info and debug logs when level is debug', () => {
    const sink = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const logger = createAppLogger({
      level: 'debug',
      sink,
      clock: () => new Date('2026-06-03T12:34:56.000Z'),
    });

    logger.info('startup.ready', { projects: 1, verbosity: 'normal' });
    logger.debug('gateway.fallback', { chat: 'oc_1', reason: 'card_failed' });

    expect(sink.info).toHaveBeenCalledTimes(2);
    expect(sink.info).toHaveBeenNthCalledWith(
      1,
      '[2026-06-03 12:34:56] INFO  startup.ready projects=1 verbosity=normal',
    );
    expect(sink.info).toHaveBeenNthCalledWith(
      2,
      '[2026-06-03 12:34:56] DEBUG gateway.fallback chat=oc_1 reason=card_failed',
    );
  });

  it('quotes strings with spaces and truncates long values', () => {
    const sink = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const logger = createAppLogger({
      level: 'info',
      sink,
      clock: () => new Date('2026-06-03T12:34:56.000Z'),
      maxValueLength: 12,
    });

    logger.info('inbound.received', {
      chat: 'oc_1',
      text: 'inspect current branch and status',
      count: 3,
    });

    expect(sink.info).toHaveBeenCalledWith(
      '[2026-06-03 12:34:56] INFO  inbound.received chat=oc_1 text="inspect cur…" count=3',
    );
  });

  it('prefers LOG_LEVEL over the configured level', () => {
    process.env.LOG_LEVEL = 'debug';
    const sink = {
      info: vi.fn(),
      error: vi.fn(),
    };
    const logger = createAppLogger({
      level: 'error',
      sink,
      clock: () => new Date('2026-06-03T12:34:56.000Z'),
    });

    logger.debug('gateway.fallback', { chat: 'oc_1' });

    expect(logger.level).toBe('debug');
    expect(sink.info).toHaveBeenCalledWith(
      '[2026-06-03 12:34:56] DEBUG gateway.fallback chat=oc_1',
    );
  });
});
