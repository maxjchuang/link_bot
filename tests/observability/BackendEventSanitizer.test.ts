import { describe, expect, it } from 'vitest';
import { sanitizeBackendEventForPersistence } from '../../src/observability/BackendEventSanitizer.js';

describe('sanitizeBackendEventForPersistence', () => {
  it('redacts device login secrets in structured values and command output', () => {
    const sanitized = sanitizeBackendEventForPersistence({
      device_code: 'device-secret',
      output: 'lark-cli auth login --device-code device-secret\nhttps://open.feishu.cn/oauth/v1/device/verify?user_code=ABCD',
      nested: { refresh_token: 'refresh-secret' },
    });
    expect(JSON.stringify(sanitized)).not.toContain('device-secret');
    expect(JSON.stringify(sanitized)).not.toContain('refresh-secret');
    expect(JSON.stringify(sanitized)).not.toContain('ABCD');
    expect(sanitized).toMatchObject({ device_code: '[redacted]', nested: { refresh_token: '[redacted]' } });
  });
});
