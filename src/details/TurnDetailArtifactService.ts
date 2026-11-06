import { createHash } from 'node:crypto';
import type { FeishuGateway } from '../feishu/FeishuGateway.js';
import type { MediaService } from '../media/MediaService.js';
import { DetailAccessPolicy, type DetailReadContext } from './DetailAccessPolicy.js';
import type { DetailResourceStore } from './DetailResourceStore.js';
import type { TurnDetailStore } from './TurnDetailStore.js';
import type { TurnResultStore } from './TurnResultStore.js';
import type { DetailCategory, DetailScope, DetailTurnIdentity } from './TurnDetailTypes.js';
import { TurnDetailService } from './TurnDetailService.js';
import { sanitizeDetailText } from './DetailSanitizer.js';
import type { DetailOutcome, DetailTelemetryPort } from './TurnDetailTelemetry.js';
import { detailAccessFailure, unavailableDetailAudit, type DetailAccessAuditPort, type DetailAccessOutcome, type DetailAccessReceipt } from './TurnDetailAccessAudit.js';
import type { MediaAttachmentRecord } from '../media/MediaTypes.js';

// Conservative byte interpretation of the installed SDK's 30M per-file contract.
export const DETAIL_UPLOAD_PART_BYTES = 30_000_000;

export interface TurnArtifactRequest {
  identity: DetailTurnIdentity; category: DetailCategory | 'result'; actor: DetailReadContext;
  through: number; version: string;
}

/** Fresh checks for a request originally created by a verified card callback. */
export function artifactAccessPolicy(gateway: FeishuGateway, actor: DetailReadContext): DetailAccessPolicy {
  let source: { chatId: string; chatType: 'private' | 'group'; topicId?: string } | undefined;
  return new DetailAccessPolicy({
    resolveSource: async (id) => {
      if (id !== actor.sourceMessageId || !gateway.resolveDetailMessageScope) return undefined;
      source = await gateway.resolveDetailMessageScope(id); return source;
    },
    isGroupMember: async (chatId, viewer) => gateway.isDetailReaderMember ? gateway.isDetailReaderMember(chatId, viewer) : false,
    canReadTopic: async (chatId, topicId, viewer) => viewer === actor.userId && source?.chatType === 'group'
      && source.chatId === chatId && source.topicId === topicId,
  });
}

/** No arbitrary paths, legacy events or persistent generated-body copy. One buffered SDK upload at a time. */
export class TurnDetailArtifactService {
  private busy = false;
  constructor(private readonly store: TurnDetailStore, private readonly files: DetailResourceStore,
    private readonly results: TurnResultStore,
    private readonly access: (actor: DetailReadContext) => DetailAccessPolicy,
    private readonly gateway: Pick<FeishuGateway, 'uploadFile' | 'sendDetailFileToTarget'>,
    private readonly media?: Pick<MediaService, 'getAttachment' | 'saveAttachment'> & Partial<Pick<MediaService, 'recordDetailArtifactDelivery'>>,
    private readonly clock: () => Date = () => new Date(), private readonly maxBytes = 50 * 1024 * 1024,
    private readonly telemetry?: DetailTelemetryPort, private readonly audit: DetailAccessAuditPort = unavailableDetailAudit) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 50 * 1024 * 1024) throw new Error('invalid_artifact_budget');
  }

  async requireRead(request: TurnArtifactRequest): Promise<DetailScope> {
    if (!['process', 'commands', 'files', 'result'].includes(request.category) || !Number.isSafeInteger(request.through) || request.through < 0
      || !/^[a-f0-9]{64}$/.test(request.version)) throw new Error('invalid_artifact');
    const policy = this.access(request.actor);
    if (request.category === 'result') {
      const metadata = this.results.metadata(request.identity);
      if (!metadata) throw new Error('not_found');
      await policy.requireRead(metadata.scope, request.actor);
      if (this.snapshot(request.identity, request.category).version !== request.version || metadata.length !== request.through) throw new Error('snapshot_changed');
      return metadata.scope;
    }
    await new TurnDetailService(this.store, this.files, policy, this.clock).requireRead(request.identity, request.actor);
    if (this.store.categorySequence(request.identity, request.category) !== request.through) throw new Error('snapshot_changed');
    if (this.snapshot(request.identity, request.category).version !== request.version) throw new Error('snapshot_changed');
    return this.store.getTurn(request.identity)!.scope;
  }

  /** An index digest freezes resource boundaries too: directory sequence alone ignores output appends. */
  snapshot(identity: DetailTurnIdentity, category: DetailCategory | 'result'): { through: number; version: string } {
    const hash = createHash('sha256');
    if (category === 'result') {
      const metadata = this.results.metadata(identity);
      if (!metadata) throw new Error('not_found');
      return { through: metadata.length, version: hash.update(JSON.stringify(metadata)).digest('hex') };
    }
    const turn = this.store.getTurn(identity);
    if (!turn) throw new Error('not_found');
    hash.update(JSON.stringify([turn.truncated, turn.incomplete]));
    const through = this.store.categorySequence(identity, category);
    for (let after = 0;;) {
      const rows = this.store.categoryPage(identity, category, after, through, 20);
      if (!rows.length) break;
      for (const { entry } of rows) hash.update(JSON.stringify(entry));
      after = rows.at(-1)!.sequence;
    }
    return { through, version: hash.digest('hex') };
  }

  async deliver(request: TurnArtifactRequest, uuid: string): Promise<{ messageId: string }> {
    let auditReceipt: DetailAccessReceipt | undefined;
    let acquired = false;
    let auditOutcome: DetailAccessOutcome = 'unavailable';
    const start = performance.now(); let outcome: DetailOutcome = 'ok';
    try {
      auditReceipt = this.audit.begin({ operation: 'download_delivery', category: request.category, actorId: request.actor.userId,
        sourceMessageId: request.actor.sourceMessageId, identity: request.identity, deliveryKey: uuid });
      if (this.busy) throw new Error('artifact_busy');
      this.busy = true; acquired = true;
      const scope = await this.requireRead(request);
      if (!this.gateway.uploadFile || !this.gateway.sendDetailFileToTarget) throw new Error('artifact_transport_unavailable');
      const attachmentId = `detail_${createHash('sha256').update(uuid).digest('hex').slice(0, 32)}`;
      let attachment = this.media?.getAttachment(attachmentId);
      if (attachment && attachment.managedSource !== 'turn_detail') throw new Error('invalid_artifact');
      let resourceKey = attachment?.remoteResourceKey;
      if (!resourceKey) {
        const generated = await this.generate(request);
        if (generated.data.length > DETAIL_UPLOAD_PART_BYTES) {
          const receipt = await this.deliverParts(request, uuid, generated);
          auditOutcome = 'delivered';
          return receipt;
        }
        await this.requireRead(request); // Check again immediately before upload.
        resourceKey = await this.gateway.uploadFile(generated.data, generated.name);
        if (!resourceKey) throw new Error('artifact_receipt_missing');
        const now = this.clock().toISOString();
        attachment = { id: attachmentId, managedSource: 'turn_detail', direction: 'outbound', kind: 'file',
          originalName: generated.name, safeName: generated.name, detectedMime: 'text/plain',
          sizeBytes: generated.data.length, sha256: createHash('sha256').update(generated.data).digest('hex'),
          storagePath: '', chatId: scope.chatId, ...(scope.kind === 'shared_group_topic' ? { topicId: scope.topicId } : {}),
          senderUserId: request.actor.userId, status: 'uploaded', remoteResourceKey: resourceKey,
          createdAt: now, updatedAt: now, expiresAt: new Date(this.clock().getTime() + 24 * 3600000).toISOString() };
        this.media?.saveAttachment(attachment);
      }
      await this.requireRead(request); // Cached uploads are not authorization tokens.
      const target = { chatId: scope.chatId, replyToMessageId: request.actor.sourceMessageId,
        ...(scope.kind === 'shared_group_topic' ? { replyInThread: true } : {}) };
      const receipt = await this.gateway.sendDetailFileToTarget(target, resourceKey, uuid);
      if (!receipt.messageId) throw new Error('artifact_receipt_missing');
      auditOutcome = 'delivered'; // A later cache/index error cannot undo an external receipt.
      if (attachment) {
        this.media?.saveAttachment({ ...attachment, status: 'sent', updatedAt: this.clock().toISOString() });
        this.media?.recordDetailArtifactDelivery?.({ uuid, attachment, target, messageId: receipt.messageId });
      }
      return { messageId: receipt.messageId };
    } catch (error) {
      if (auditOutcome !== 'delivered') auditOutcome = detailAccessFailure(error);
      const code = error instanceof Error ? error.message : '';
      outcome = code === 'access_denied' ? 'denied' : code === 'expired' || code === 'cleared' ? 'expired' : 'unavailable';
      throw error;
    } finally {
      if (acquired) this.busy = false;
      // If this write fails, the durable attempt remains unresolved, never fabricated as success.
      try { auditReceipt?.finish(auditOutcome); }
      catch (error) { outcome = 'unavailable'; throw error; }
      finally {
        try { this.telemetry?.observe('download', outcome, performance.now() - start); } catch { /* Isolated metrics. */ }
      }
    }
  }

  private async deliverParts(request: TurnArtifactRequest, uuid: string,
    generated: { data: Buffer; name: string }): Promise<{ messageId: string }> {
    const parts: Buffer[] = [];
    for (let start = 0; start < generated.data.length;) {
      let end = Math.min(start + DETAIL_UPLOAD_PART_BYTES, generated.data.length);
      if (end < generated.data.length) while (end > start && (generated.data[end]! & 0xc0) === 0x80) end--;
      if (end <= start) throw new Error('invalid_artifact');
      parts.push(generated.data.subarray(start, end)); start = end;
    }
    let last: { messageId: string } | undefined;
    for (const [index, data] of parts.entries()) {
      const partUuid = createHash('sha256').update(`${uuid}:part:${index}`).digest('hex').slice(0, 32);
      const audit = this.audit.begin({ operation: 'download_delivery', category: request.category, actorId: request.actor.userId,
        sourceMessageId: request.actor.sourceMessageId, identity: request.identity, deliveryKey: partUuid });
      let outcome: DetailAccessOutcome = 'unavailable';
      try {
        const scope = await this.requireRead(request);
        const attachmentId = `detail_${createHash('sha256').update(partUuid).digest('hex').slice(0, 32)}`;
        let attachment = this.media?.getAttachment(attachmentId);
        if (attachment && attachment.managedSource !== 'turn_detail') throw new Error('invalid_artifact');
        let resourceKey = attachment?.remoteResourceKey;
        if (!resourceKey) {
          await this.requireRead(request);
          // Fragments must never masquerade as independently applicable patches.
          const name = `${generated.name}.part-${index + 1}-of-${parts.length}.txt`;
          resourceKey = await this.gateway.uploadFile!(data, name);
          if (!resourceKey) throw new Error('artifact_receipt_missing');
          const now = this.clock().toISOString();
          attachment = { id: attachmentId, managedSource: 'turn_detail', direction: 'outbound', kind: 'file', originalName: name,
            safeName: name, detectedMime: 'text/plain', sizeBytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
            storagePath: '', chatId: scope.chatId, ...(scope.kind === 'shared_group_topic' ? { topicId: scope.topicId } : {}),
            senderUserId: request.actor.userId, status: 'uploaded', remoteResourceKey: resourceKey,
            createdAt: now, updatedAt: now, expiresAt: new Date(this.clock().getTime() + 24 * 3600000).toISOString() } satisfies MediaAttachmentRecord;
          this.media?.saveAttachment(attachment);
        }
        await this.requireRead(request);
        const target = { chatId: scope.chatId, replyToMessageId: request.actor.sourceMessageId,
          ...(scope.kind === 'shared_group_topic' ? { replyInThread: true } : {}) };
        last = await this.gateway.sendDetailFileToTarget!(target, resourceKey, partUuid);
        if (!last.messageId) throw new Error('artifact_receipt_missing');
        outcome = 'delivered';
        if (attachment) {
          this.media?.saveAttachment({ ...attachment, status: 'sent', updatedAt: this.clock().toISOString() });
          this.media?.recordDetailArtifactDelivery?.({ uuid: partUuid, attachment, target, messageId: last.messageId });
        }
      } catch (error) { if (outcome !== 'delivered') outcome = detailAccessFailure(error); throw error; }
      finally { audit.finish(outcome); }
    }
    if (!last) throw new Error('invalid_artifact');
    return last;
  }

  private async generate(request: TurnArtifactRequest): Promise<{ data: Buffer; name: string }> {
    await this.requireRead(request);
    const chunks: Buffer[] = []; let bytes = 0, limited = false, review = false;
    const append = (buffer: Buffer): boolean => {
      const remaining = this.maxBytes - 160 - bytes;
      if (buffer.length <= remaining) { chunks.push(buffer); bytes += buffer.length; return true; }
      let end = Math.max(0, remaining);
      while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
      if (end) { chunks.push(buffer.subarray(0, end)); bytes += end; }
      limited = true; return false;
    };
    append(Buffer.from(sanitizeDetailText(`# Link Bot sanitized ${request.category}\nTurn: ${JSON.stringify(request.identity)}\nScope: ${JSON.stringify(await this.requireRead(request))}\nPublished copies cannot be recalled.\n`).text));
    if (request.category === 'result') {
      for (let offset = 0; !limited;) {
        const page = this.results.readPage(request.identity, offset);
        if (!append(Buffer.from(page.text)) || page.nextOffset === undefined) break;
        offset = page.nextOffset;
        if (offset % 128000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } else {
      const turn = this.store.getTurn(request.identity)!;
      review = turn.incomplete === true || turn.truncated;
      for (let after = 0; !limited;) {
        const rows = this.store.categoryPage(request.identity, request.category, after, request.through, 20);
        if (!rows.length) { if (after === 0 && request.category === 'files') review = true; break; }
        for (const { entry } of rows) {
          const incomplete = entry.missing || !entry.resource || entry.resource.redacted || entry.resource.truncated
            || (request.category === 'files' && (entry.metadata.complete !== true || entry.metadata.binary === true));
          review ||= Boolean(incomplete);
          if (request.category !== 'files') append(Buffer.from(sanitizeDetailText(`\n# ${JSON.stringify(entry.metadata)}\n# stream/source: ${entry.source ?? 'combined'}; incomplete/redacted: ${Boolean(incomplete)}\n`).text));
          if (entry.resource) for (let offset = 0; offset < entry.resource.committedBytes && !limited;) {
            const data = this.files.readBytes(entry.resource.resourceId, entry.resource.committedBytes, offset,
              Math.min(64 * 1024, entry.resource.committedBytes - offset));
            append(data); offset += data.length;
            if (offset % (256 * 1024) === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          }
          if (limited) break;
        }
        after = rows.at(-1)!.sequence;
      }
    }
    if (limited || review) { const warning = Buffer.from('\n# REVIEW TEXT ONLY: retained data is incomplete, redacted or export-budget limited. Not an applicable complete patch.\n'); chunks.push(warning); bytes += warning.length; }
    const name = request.category === 'files' ? limited || review ? 'linkbot-changes.review.txt' : 'linkbot-changes.patch'
      : request.category === 'result' ? 'linkbot-result.txt' : `linkbot-${request.category}.log.txt`;
    return { data: Buffer.concat(chunks, bytes), name };
  }
}
