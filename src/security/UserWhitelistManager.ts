import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotConfig } from '../domain/types.js';
import type { FeishuUserMention } from '../feishu/FeishuGateway.js';

const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/;

export function resolveMentionedOpenIds(rawMentions: string[], mentions: FeishuUserMention[]):
  { openIds: string[] } | { error: string } {
  const tokens = rawMentions.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  if (tokens.length === 0) return { error: 'Usage: /adduser @username [@username ...]' };
  const openIds: string[] = [];
  for (const token of tokens) {
    const mention = mentions.find((candidate) =>
      candidate.key === token
      || candidate.key.replace(/^@/, '') === token.replace(/^@/, '')
      || (candidate.name ? `@${candidate.name}` === token : false));
    if (!mention || !OPEN_ID_PATTERN.test(mention.openId)) {
      return { error: `Unresolved Feishu user mention: ${token}. Select the user with Feishu @ mention.` };
    }
    if (!openIds.includes(mention.openId)) openIds.push(mention.openId);
  }
  return { openIds };
}

export class UserWhitelistManager {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly config: BotConfig,
  ) {}

  addUsers(requesterUserId: string, rawIds: string[]): Promise<string> {
    const operation = this.pending.then(() => this.addUsersNow(requesterUserId, rawIds));
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async addUsersNow(requesterUserId: string, rawIds: string[]): Promise<string> {
    if (!this.config.upgrade.adminUsers.includes(requesterUserId)) {
      return 'Only administrators can use /adduser.';
    }

    const openIds = [...new Set(rawIds.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean))];
    if (openIds.length === 0) return 'Usage: /adduser @username [@username ...]';
    const invalid = openIds.find((openId) => !OPEN_ID_PATTERN.test(openId));
    if (invalid) return `Invalid Feishu open_id: ${invalid}`;

    const configPath = resolve(this.projectRoot, '.link-bot/config.json');
    const diskConfig = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    const current = Array.isArray(diskConfig.allowedUsers)
      ? diskConfig.allowedUsers.filter((value): value is string => typeof value === 'string')
      : [];
    const existing = openIds.filter((openId) => current.includes(openId));
    const added = openIds.filter((openId) => !current.includes(openId));

    if (added.length > 0) {
      diskConfig.allowedUsers = [...current, ...added];
      const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(diskConfig, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, configPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      this.config.allowedUsers.splice(0, this.config.allowedUsers.length, ...current, ...added);
    }

    const lines = [];
    if (added.length > 0) lines.push(`Added to user whitelist: ${added.join(', ')}`);
    if (existing.length > 0) lines.push(`Already allowlisted: ${existing.join(', ')}`);
    return lines.join('\n');
  }
}
