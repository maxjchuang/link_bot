import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('repository agent instructions', () => {
  it('forbids committing Superpowers implementation plans', async () => {
    const instructions = await readFile('AGENTS.md', 'utf8');

    expect(instructions).toContain('docs/superpowers/plans/');
    expect(instructions).toContain('MUST NOT commit');
    expect(instructions).toContain('MUST NOT use `git add -f`');
    expect(instructions).toContain('MUST inspect staged files before every commit');
    expect(instructions).toContain('skill or workflow');
  });
});
