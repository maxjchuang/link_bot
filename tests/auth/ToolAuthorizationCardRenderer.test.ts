import { describe, expect, it, vi } from 'vitest';
import { createToolAuthorizationCardRenderer } from '../../src/auth/ToolAuthorizationCardRenderer.js';
import type { PendingAuthenticatedTurn } from '../../src/auth/AuthTypes.js';

describe('ToolAuthorizationCardRenderer', () => {
  it('uploads a generated PNG and renders only the returned Feishu image key', async () => {
    const uploadImage = vi.fn(async (image: Buffer) => {
      expect(image.subarray(1, 4).toString()).toBe('PNG');
      return 'img_uploaded_key';
    });
    const rendered = await createToolAuthorizationCardRenderer({ uploadImage })(pending());
    const json = JSON.stringify(rendered.preferred);
    expect(json).toContain('img_uploaded_key');
    expect(json).not.toContain('/workspace/');
  });

  it('falls back to the link-and-button card when image upload fails', async () => {
    const onFallback = vi.fn();
    const rendered = await createToolAuthorizationCardRenderer({
      uploadImage: vi.fn(async () => { throw new Error('upload unavailable'); }),
    }, onFallback)(pending());
    const json = JSON.stringify(rendered.preferred);
    expect(json).not.toContain('"tag":"img"');
    expect(json).toContain('https://auth.example/device');
    expect(json).toContain('我已授权');
    expect(onFallback).toHaveBeenCalledOnce();
  });
});

function pending(): PendingAuthenticatedTurn {
  return {
    id: 'auth_1', provider: 'lark', text: 'read doc', loginSessionId: 'session_1',
    authorizationUrl: 'https://auth.example/device', expiresAt: '2026-08-12T18:00:00Z',
    createdAt: '2026-08-12T17:45:00Z', chatId: 'oc_group', chatType: 'group', userId: 'ou_owner',
  };
}
