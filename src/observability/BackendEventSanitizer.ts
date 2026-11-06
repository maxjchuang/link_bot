const SECRET_KEY = /^(?:device_code|user_code|access_token|refresh_token|client_secret)$/i;

export function sanitizeBackendEventForPersistence<T>(event: T): T {
  return sanitize(event) as T;
}

function sanitize(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([nestedKey, nestedValue]) => [nestedKey, sanitize(nestedValue, nestedKey)]));
}

function redactText(value: string): string {
  return value
    .replace(/(--device-code(?:=|\s+))([^\s"']+)/gi, '$1[redacted]')
    .replace(/((?:device_code|user_code|access_token|refresh_token|client_secret)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"']+\/oauth\/v1\/device\/verify\?[^\s"']*/gi,
      (url) => `${url.split('?')[0]}?params=[redacted]`);
}
