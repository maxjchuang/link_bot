import { describe, expect, it } from 'vitest';
import { runtimeProxyEnvironment } from '../../src/app/createTaskPlatform.js';

describe('runtimeProxyEnvironment', () => {
  it('does not inject deployment-specific proxy defaults', () => {
    expect(runtimeProxyEnvironment({})).toEqual({});
  });

  it('allows deployment-specific Go and HTTP proxy overrides', () => {
    expect(runtimeProxyEnvironment({
      GOPROXY: 'https://custom.proxy', GONOPROXY: 'internal.example',
      GONOSUMDB: 'internal.example', HTTP_PROXY: 'http://http.proxy',
    })).toMatchObject({
      GOPROXY: 'https://custom.proxy', GONOPROXY: 'internal.example',
      GONOSUMDB: 'internal.example', HTTP_PROXY: 'http://http.proxy',
    });
  });
});
