const ELIGIBLE_TYPES = new Set(['user.message', 'turn.completed']);

export interface DreamEvent {
  sequence: number;
  eventKey: string;
  eventType: string;
  payload: unknown;
}

export interface SanitizedDreamEvent {
  sequence: number;
  eventKey: string;
  eventType: string;
  untrustedData: true;
  text: string;
}

export function sanitizeDreamEvents(events: DreamEvent[], maxChars = 24_000): SanitizedDreamEvent[] {
  const output: SanitizedDreamEvent[] = [];
  let used = 0;
  for (const event of events) {
    if (!ELIGIBLE_TYPES.has(event.eventType)) continue;
    const raw = safeJson(event.payload);
    if (raw.length > 12_000) continue;
    const text = redactSensitive(raw).slice(0, 6_000);
    if (!text || used + text.length > maxChars) break;
    output.push({
      sequence: event.sequence, eventKey: event.eventKey, eventType: event.eventType,
      untrustedData: true, text,
    });
    used += text.length;
  }
  return output;
}

export function redactSensitive(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[redacted-private-key]')
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\b\s*[:=]\s*["']?[^\s,"'}]+/gi, '[redacted-secret]')
    .replace(/\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable event omitted]';
  }
}
