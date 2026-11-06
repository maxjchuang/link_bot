import { describe, expect, it } from 'vitest';
import type { CommandName } from '../../src/commands/CommandRouter.js';
import { parseIncomingText } from '../../src/commands/CommandRouter.js';

describe('parseIncomingText', () => {
  it('includes upgrade in known command names', () => {
    const commandName: CommandName = 'upgrade';
    expect(commandName).toBe('upgrade');
  });

  it('includes restart in known command names', () => {
    const commandName: CommandName = 'restart';
    expect(commandName).toBe('restart');
  });

  it('includes hook commands in known command names', () => {
    const commands: CommandName[] = ['hook-status', 'install-hooks', 'uninstall-hooks'];
    expect(commands).toEqual(['hook-status', 'install-hooks', 'uninstall-hooks']);
  });

  it('treats a leading group mention before a slash command as a command', () => {
    expect(parseIncomingText('@_user_1 /projects')).toEqual({
      kind: 'command',
      name: 'projects',
      args: [],
      raw: '/projects',
    });
  });

  it('parses /model with no args as a command', () => {
    expect(parseIncomingText('/model')).toEqual({
      kind: 'command',
      name: 'model',
      args: [],
      raw: '/model',
    });
  });

  it('parses /upgrade as a command', () => {
    expect(parseIncomingText('/upgrade')).toEqual({
      kind: 'command',
      name: 'upgrade',
      args: [],
      raw: '/upgrade',
    });
  });

  it('parses /restart as a command', () => {
    expect(parseIncomingText('/restart')).toEqual({
      kind: 'command',
      name: 'restart',
      args: [],
      raw: '/restart',
    });
  });

  it.each(['/hook-status', '/install-hooks', '/uninstall-hooks'])('parses %s as a command', (text) => {
    expect(parseIncomingText(text)).toMatchObject({
      kind: 'command',
      name: text.slice(1),
      args: [],
    });
  });

  it('parses current commands', () => {
    expect(parseIncomingText('/current')).toEqual({
      kind: 'command',
      name: 'current',
      args: [],
      raw: '/current',
    });
  });

  it('parses /model with model and reasoning args as a command', () => {
    expect(parseIncomingText('/model gpt-5.5 high')).toEqual({
      kind: 'command',
      name: 'model',
      args: ['gpt-5.5', 'high'],
      raw: '/model gpt-5.5 high',
    });
  });
});
