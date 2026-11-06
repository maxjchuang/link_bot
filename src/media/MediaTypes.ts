export type MediaKind = 'image' | 'file';

export interface IncomingResourceDescriptor {
  kind: MediaKind;
  resourceKey: string;
  resourceOwnerMessageId: string;
  fileName?: string;
}

export type MediaAttachmentStatus =
  | 'pending'
  | 'downloading'
  | 'ready'
  | 'staged'
  | 'exported'
  | 'uploaded'
  | 'sent'
  | 'rejected'
  | 'failed';

export interface MediaAttachmentRecord {
  /** Remote-only generated safe detail artifact; never read storagePath or auto-publish it. */
  managedSource?: 'turn_detail';
  id: string;
  direction: 'inbound' | 'outbound';
  kind: MediaKind;
  externalMessageId?: string;
  resourceKey?: string;
  /** Provenance for scoped handoff projections, outside the global ingress dedupe key. */
  handoffSource?: { messageId: string; resourceKey: string };
  forwardedEnvelopeMessageId?: string;
  remoteResourceKey?: string;
  originalName: string;
  safeName: string;
  declaredMime?: string;
  detectedMime: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  chatId: string;
  topicId?: string;
  senderUserId?: string;
  taskId?: string;
  turnId?: string;
  caption?: string;
  status: MediaAttachmentStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  failureReason?: string;
}

export interface PreparedInboundMedia {
  images: Array<{ url: string; detail: 'auto' }>;
  promptContext?: string;
  attachmentIds: string[];
}

export interface ArtifactPublishInput {
  path: string;
  disposition: 'auto' | 'image' | 'file';
  displayName: string;
  caption?: string;
}
