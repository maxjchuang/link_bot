import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EncryptedUserCredentialStore } from '../auth/EncryptedUserCredentialStore.js';
import type { FeishuGateway } from '../feishu/FeishuGateway.js';
import { DetailSanitizer, sanitizePublicAnswerText } from './DetailSanitizer.js';

export interface SensitiveReplyContext {
  requesterUserId: string;
  ownerUserId: string;
  chatId: string;
  sourceMessageId?: string;
}
interface DeliveryRecord extends SensitiveReplyContext {
  ref: string; text: string; expiresAt: number; attempts: number;
  status: 'pending' | 'sent' | 'failed'; messageIds: string[];
}
const TTL_MS = 15 * 60_000;
const MAX_BYTES = 128 * 1024;
const PROVIDER = 'reply';

/** A separate encrypted delivery lane. Raw values never enter results, audit, or the generic outbox. */
export class SensitiveReplyDelivery {
  private readonly credentials: EncryptedUserCredentialStore;
  private readonly flights = new Map<string, Promise<string>>();
  private readonly preparations = new Map<string, Promise<string>>();
  constructor(private readonly root: string,
    private readonly gateway: Pick<FeishuGateway, 'verifySensitiveReplySource' | 'sendSensitiveReplyPrivate'>,
    private readonly clock: () => Date = () => new Date(), private readonly enabled = true) {
    this.credentials = new EncryptedUserCredentialStore(root);
  }

  async prepare(context: SensitiveReplyContext, text: string): Promise<string> {
    const key = JSON.stringify([context.chatId, context.sourceMessageId, context.requesterUserId]);
    const prior = this.preparations.get(key);
    if (prior) return prior;
    const run = this.prepareOnce(context, text);
    this.preparations.set(key, run);
    return run.finally(() => { if (this.preparations.get(key) === run) this.preparations.delete(key); });
  }

  private async prepareOnce(context: SensitiveReplyContext, text: string): Promise<string> {
    const publicText = sanitizePublicAnswerText(text);
    const hidden = hiddenReplyLines(text);
    if (!hidden) return publicText;
    const kinds = [
      /https?:\/\//i.test(hidden) ? '授权或带敏感参数的链接' : '',
      /PRIVATE KEY/.test(hidden) ? '私钥' : '',
      /authorization\s*:|cookie\s*:/i.test(hidden) ? '认证头或会话凭据' : '',
      /token|secret|password|passwd|api[_-]?key|\bsk-/i.test(hidden) ? '令牌、密钥或密码' : '',
    ].filter(Boolean).join('、') || '敏感凭据内容';
    const prefix = `\n\n隐私说明：本答复已隐藏 ${hidden.split('\n').length} 行${kinds}，避免在当前会话及其历史记录中明文传播。`;
    // Put the receipt/status first so a bounded final-card preview cannot hide it again.
    const explain = (outcome: string) => `${prefix.trimStart()}${outcome}\n\n${publicText}`;
    if (!this.enabled) return explain('私聊交付开关已关闭，未发送；请联系机器人维护者恢复后重新请求。');
    if (context.requesterUserId !== context.ownerUserId || !/^ou_[\w-]+$/.test(context.requesterUserId)
      || !context.sourceMessageId) return explain('无法确认其归属于本次请求者，未私聊转发；请由原请求者重新发起。');
    if (Buffer.byteLength(hidden) > MAX_BYTES || hidden.split('\n').some((line) => Buffer.byteLength(line) > 12_000)) {
      return explain('内容超过安全投递上限，未发送；请缩小请求范围后重试。');
    }
    const ref = createHash('sha256').update(JSON.stringify([context.chatId, context.sourceMessageId, context.requesterUserId]))
      .digest('hex').slice(0, 32);
    try {
      const prior = await this.load(ref);
      if (!prior) await this.save({ ...context, ref, text: hidden, expiresAt: this.clock().getTime() + TTL_MS,
        attempts: 0, status: 'pending', messageIds: [] });
      const outcome = await this.deliver(ref, context.requesterUserId);
      return explain(outcome);
    } catch {
      // Even storage/API errors may contain the original URL. Never surface their messages.
      return explain('私聊投递未完成，不能确认已发送；请重新请求授权入口。');
    }
  }

  async retry(ref: string, userId: string): Promise<string> {
    if (!this.enabled) return '私聊交付开关已关闭，未发送。';
    if (!/^[a-f0-9]{32}$/.test(ref)) return '私聊投递记录不存在。';
    try { return await this.deliver(ref, userId); }
    catch { return '私聊投递暂不可用，请稍后重试。'; }
  }

  private deliver(ref: string, userId: string): Promise<string> {
    // Key by actor as well: a different user must never receive another actor's in-flight result.
    const key = `${ref}:${userId}`;
    const prior = this.flights.get(key);
    if (prior) return prior;
    const flight = this.deliverOnce(ref, userId);
    this.flights.set(key, flight);
    return flight.finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
  }

  private async deliverOnce(ref: string, userId: string): Promise<string> {
    const record = await this.load(ref);
    if (!record || record.requesterUserId !== userId || record.ownerUserId !== userId) return '无可重试的私聊投递记录，或你不是原请求者。';
    if (record.expiresAt <= this.clock().getTime()) {
      await this.credentials.remove(PROVIDER, ref);
      return '私聊投递记录已过期，请重新请求授权入口；不会补发过期链接。';
    }
    if (record.status === 'sent') return '已通过 code bot 私聊发送给本次请求者，请查看机器人私聊。';
    if (record.attempts >= 5) return '私聊投递已达到重试上限，请重新请求授权入口。';
    try {
      if (!this.gateway.verifySensitiveReplySource || !this.gateway.sendSensitiveReplyPrivate
        || !await deliveryDeadline(this.gateway.verifySensitiveReplySource(record.sourceMessageId!, record.chatId, userId))) {
        return `无法核验原消息与请求者身份，未私聊发送；原请求者可在机器人私聊发送 /retry-sensitive ${ref} 重试。`;
      }
      record.attempts++;
      record.status = 'pending';
      await this.save(record); // Persist ownership and intent before any remote side effect.
      const parts = splitPrivateText(record.text);
      for (let index = record.messageIds.length; index < parts.length; index++) {
        if (record.expiresAt <= this.clock().getTime()) throw new Error('private_delivery_expired');
        const uuid = createHash('sha256').update(`${ref}:${index}`).digest('hex').slice(0, 32);
        const receipt = await deliveryDeadline(this.gateway.sendSensitiveReplyPrivate(userId,
          `Link Bot：以下是你请求的、未在原会话展示的内容（${index + 1}/${parts.length}）。\n请勿转发；授权链接过期后需重新申请。\n\n${parts[index]}`, uuid));
        if (!receipt.messageId) throw new Error('private_receipt_missing');
        record.messageIds.push(receipt.messageId);
        await this.save(record);
      }
      record.status = 'sent';
      // No need to keep a recoverable plaintext-equivalent payload after successful delivery.
      record.text = '';
      await this.save(record);
      return '已通过 code bot 私聊发送给本次请求者，请查看机器人私聊。';
    } catch {
      record.status = 'failed';
      await this.save(record);
      return `私聊投递未完成（可能部分已发送），不能确认全部送达。请在机器人私聊发送 /retry-sensitive ${ref} 重试；记录自首次投递起保留 15 分钟，过期后需重新请求授权入口。`;
    }
  }

  /** Called by independent maintenance; expired payloads are removed even without another user request. */
  async cleanup(): Promise<void> {
    const names = await readdir(join(this.root, Buffer.from(PROVIDER).toString('base64url'))).catch(() => [] as string[]);
    for (const name of names) {
      if (!name.endsWith('.enc')) continue;
      const ref = Buffer.from(name.slice(0, -4), 'base64url').toString();
      if (!/^[a-f0-9]{32}$/.test(ref)) continue;
      try {
        const record = await this.load(ref);
        if (record && record.expiresAt <= this.clock().getTime()) await this.credentials.remove(PROVIDER, ref);
      } catch { /* A corrupt entry must not block expiration of the other entries. */ }
    }
  }
  private async load(ref: string): Promise<DeliveryRecord | undefined> {
    const raw = await this.credentials.read(PROVIDER, ref);
    return raw ? JSON.parse(raw.toString()) as DeliveryRecord : undefined;
  }
  private save(record: DeliveryRecord): Promise<void> {
    return this.credentials.write(PROVIDER, record.ref, Buffer.from(JSON.stringify(record)));
  }
}

function hiddenReplyLines(text: string): string {
  const stream = new DetailSanitizer({ maxLineChars: Math.max(4096, text.length) });
  const hidden: string[] = [];
  for (const line of text.split('\n')) {
    const safe = stream.push(`${line}\n`).text;
    if (safe.includes('[敏感内容已隐藏]') && line.trim() && !line.includes('[敏感内容已隐藏]')) hidden.push(line);
  }
  return hidden.join('\n');
}
function splitPrivateText(text: string): string[] {
  const parts: string[] = []; let part = '';
  for (const line of text.split('\n')) {
    if (part && Buffer.byteLength(part + '\n' + line) > 12_000) { parts.push(part); part = ''; }
    part += (part ? '\n' : '') + line;
  }
  if (part) parts.push(part);
  return parts;
}

async function deliveryDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('private_delivery_timeout')), 30_000);
      timer.unref();
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
