import {expect, it} from 'vitest';
import {sanitizeDetailText} from '../../src/details/DetailSanitizer.js';

it('retains ordinary business URL parameters while protecting actual authorization links', () => {
  for (const url of ['https://example.test/issues?ticket=123&state=open',
    'https://example.test/build?code=build-42&client_id=public-client']) {
    expect(sanitizeDetailText(url)).toEqual({text: url, redacted: false});
  }
  expect(sanitizeDetailText('https://example.test/oauth/authorize?state=private').redacted).toBe(true);
  expect(sanitizeDetailText('https://example.test/callback?access_token=private').redacted).toBe(true);
  expect(sanitizeDetailText('https://auth.example.test/start?ticket=private').redacted).toBe(true);
  expect(sanitizeDetailText('https://example.test/oauth/callback?code=private').redacted).toBe(true);
  const credentialUrl = new URL('https://example.test/resource');
  credentialUrl.username = 'fixture-user';
  credentialUrl.password = 'fixture-password';
  expect(sanitizeDetailText(credentialUrl.toString()).redacted).toBe(true);
});
