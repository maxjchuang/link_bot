import { describe, expect, it } from 'vitest';
import { formatDisplayTime } from '../../src/output/DisplayTimeFormatter.js';

describe('formatDisplayTime', () => {
  it('formats ISO timestamps in the configured IANA time zone', () => {
    expect(formatDisplayTime('2026-06-05T10:00:00.000Z', 'Asia/Shanghai')).toBe(
      '2026-06-05 18:00:00 Asia/Shanghai',
    );
    expect(formatDisplayTime('2026-06-05T10:00:00.000Z', 'UTC')).toBe('2026-06-05 10:00:00 UTC');
  });

  it('keeps invalid timestamps readable', () => {
    expect(formatDisplayTime('not-a-date', 'Asia/Shanghai')).toBe('not-a-date');
  });
});
