const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

export function sanitizeFeishuText(text: string): string {
  return text.replace(EMAIL_ADDRESS_PATTERN, '[EMAIL_REDACTED]');
}
