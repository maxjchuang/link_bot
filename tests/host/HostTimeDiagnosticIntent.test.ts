import { describe, expect, it } from 'vitest';
import { parseHostTimeDiagnosticIntent } from '../../src/host/HostTimeDiagnosticIntent.js';

const NOW = new Date('2026-09-02T08:30:00.000Z'); // 16:30 Asia/Shanghai

describe('parseHostTimeDiagnosticIntent', () => {

  it('supports explicit current, previous, and dated diagnostic forms', () => {
    expect(parseHostTimeDiagnosticIntent('/diag 1015', NOW)).toMatchObject({
      kind: 'diagnose', date: '2026-09-02', time: '10:15',
    });
    expect(parseHostTimeDiagnosticIntent('/diag yesterday 2359', NOW)).toMatchObject({
      kind: 'diagnose', date: '2026-09-01', time: '23:59',
    });
    expect(parseHostTimeDiagnosticIntent('/diag 2026-08-31 0033', NOW)).toMatchObject({
      kind: 'diagnose', date: '2026-08-31', time: '00:33',
    });
  });

  it('does not hijack four digits embedded in normal text', () => {
    expect(parseHostTimeDiagnosticIntent('MR !1206', NOW)).toEqual({ kind: 'none' });
    expect(parseHostTimeDiagnosticIntent('编号 1626', NOW)).toEqual({ kind: 'none' });
  });

  it('rejects invalid and future bare times with actionable guidance', () => {
    expect(parseHostTimeDiagnosticIntent('2460', NOW)).toMatchObject({ kind: 'invalid' });
    expect(parseHostTimeDiagnosticIntent('/diag', NOW)).toMatchObject({ kind: 'invalid' });
    expect(parseHostTimeDiagnosticIntent('2359', NOW)).toEqual({
      kind: 'future', reply: '今天 23:59 尚未到达。若要查询昨天，请发送 /diag yesterday 2359。',
    });
  });
});
