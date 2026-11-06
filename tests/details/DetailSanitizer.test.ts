import { describe, expect, it } from 'vitest';
import { DetailSanitizer, isSensitiveDetailCommand, sanitizeDetailText } from '../../src/details/DetailSanitizer.js';

describe('detail sanitizer', () => {
  it('previews incomplete progress without committing a split secret or changing key state', () => {
    const s = new DetailSanitizer();
    s.push('API_KEY=fake-');
    expect(s.preview().text).toBe('[敏感内容已隐藏]');
    s.push('test-secret');
    expect(s.preview().text).not.toContain('fake-test-secret');
    expect(s.push('\n').text).toBe('[敏感内容已隐藏]\n');
    const key = new DetailSanitizer();
    key.push('-----BEGIN PRIVATE KEY-----');
    expect(key.preview().text).toBe('[敏感内容已隐藏]');
    expect(key.push('\nbody\n').text).not.toContain('body');
  });

  it('hides quoted JSON credentials and multiline values before publishing a safe copy', () => {
    for (const text of ['{"access_token": "fake-test-secret"}', '{"client_secret" : "fake-test-secret"}',
      '"refresh_token":\n"fake-test-secret"\n', '"API_KEY": {\n"value": "fake-test-secret"\n}\n']) {
      const safe = sanitizeDetailText(text);
      expect(safe.redacted).toBe(true);
      expect(safe.text).not.toContain('fake-test-secret');
    }
  });
  it('hides credential lines and usable authorization links including Diff additions', () => {
    for (const value of ['Authorization: Bearer fake-test-secret', 'Cookie: sid=fake-test-secret',
      '+API_KEY=fake-test-secret', 'https://example.test/oauth/authorize?client_id=fake&state=abc',
      'https://example.test/callback?code=fake-test-secret', 'password="fake-test-secret"',
      'https://example.test/open-apis/authen/v1/authorize?app_id=fake&state=fake-test-secret',
      '--token fake-test-secret', 'sk-proj-fake-test-secret']) {
      const result = sanitizeDetailText(value);
      expect(result.redacted).toBe(true);
      expect(result.text).not.toContain('fake-test-secret');
    }
    expect(sanitizeDetailText('normal\nnext\n')).toEqual({ text: 'normal\nnext\n', redacted: false });
  });

  it('waits for line boundaries and covers secrets split across deltas', () => {
    const sanitizer = new DetailSanitizer();
    expect(sanitizer.push('API_').text).toBe('');
    expect(sanitizer.push('KEY=fake-test-').text).toBe('');
    expect(sanitizer.push('secret\nnormal\n')).toEqual({ text: '[敏感内容已隐藏]\nnormal\n', redacted: true });
    expect(sanitizer.finish()).toEqual({ text: '', redacted: true });
  });

  it('bounds unfinished lines without publishing raw tails and resumes at the next line', () => {
    const sanitizer = new DetailSanitizer({ maxLineChars: 32 });
    expect(sanitizer.push('x'.repeat(100)).text).toBe('[未安全记录的长行已隐藏]');
    expect(sanitizer.bufferedChars).toBeLessThanOrEqual(32);
    expect(sanitizer.push('tail\nsafe\n').text).toBe('\nsafe\n');
    expect(sanitizer.finish().redacted).toBe(true);
  });

  it('suppresses sensitive operations, multiline private keys and terminal escape sequences', () => {
    expect(isSensitiveDetailCommand('lark-cli auth login')).toBe(true);
    expect(isSensitiveDetailCommand('cat /workspace/.env')).toBe(true);
    expect(isSensitiveDetailCommand('cat /codex/auth.json')).toBe(true);
    expect(isSensitiveDetailCommand('npm test')).toBe(false);
    const blocked = new DetailSanitizer({ sensitiveOperation: true });
    expect(blocked.push('fake-test-secret\n').text).not.toContain('fake-test-secret');
    expect(blocked.finish().redacted).toBe(true);
    const key = new DetailSanitizer();
    const output = key.push('-----BEGIN PRIVATE KEY-----\nsecretbody\n-----END PRIVATE KEY-----\nsafe\n').text;
    expect(output).not.toContain('secretbody');
    expect(output).toContain('safe');
    expect(sanitizeDetailText('\x1b[31mTOKEN=fake-test-secret\x1b[0m').text).not.toContain('fake-test-secret');
  });
});
