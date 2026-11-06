import { describe, expect, it } from 'vitest';
import { SUPPORTED_CODEX_CLI_VERSION, SUPPORTED_CODEX_CLI_VERSIONS } from '../../src/appserver/AppServerProtocol.js';

describe('app-server protocol compatibility', () => {
  it('accepts the Codex CLI version installed on the host', () => {
    expect(SUPPORTED_CODEX_CLI_VERSION).toBe('0.161.0');
    expect(SUPPORTED_CODEX_CLI_VERSIONS).toContain('0.161.0');
    expect(SUPPORTED_CODEX_CLI_VERSIONS).toContain('0.156.1');
  });
});
