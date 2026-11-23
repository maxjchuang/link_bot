import type {GroupLifecycleEvent} from '../security/GroupServiceTypes.js';

export interface PlatformGroupLifecycleEvent {
  app_id?: string;
  event_id?: string;
  event_type?: string;
  create_time?: string;
  chat_id?: string;
  operator_id?: {open_id?: string};
}

/** SDK flattens the authenticated v2 header + event before invoking handlers. */
export function normalizeGroupLifecycleEvent(
  data: PlatformGroupLifecycleEvent, appId: string, kind: GroupLifecycleEvent['kind'],
): GroupLifecycleEvent | undefined {
  const type = kind === 'added' ? 'im.chat.member.bot.added_v1' : 'im.chat.member.bot.deleted_v1';
  if (data.app_id !== appId || data.event_type !== type || !data.event_id || !data.chat_id
    || !data.create_time || !/^\d+$/.test(data.create_time)) return undefined;
  const occurredAt = Number(data.create_time);
  if (!Number.isSafeInteger(occurredAt) || occurredAt <= 0) return undefined;
  return {kind, eventId: data.event_id, chatId: data.chat_id, occurredAt,
    ...(data.operator_id?.open_id ? {operatorUserId: data.operator_id.open_id} : {})};
}
