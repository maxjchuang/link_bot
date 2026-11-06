export interface SanitizedDetailText { text: string; redacted: boolean }

const HIDDEN = '[敏感内容已隐藏]';
const LONG_LINE = '[未安全记录的长行已隐藏]';
const SENSITIVE_LINE = /(?:authorization\s*:|cookie\s*:|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|authorization[_-]?code)["'\\]*\s*[=:]|--(?:token|password|api-key|secret)(?:\s|=)|\bsk-(?:proj-|ant-)?[a-z0-9_-]+|https?:\/\/\S*(?:\/authorize(?:[?/#]|$)|[?&](?:code|token|access_token|auth_code|ticket|user_code|device_code|state|client_id)=))/i;
const SENSITIVE_CONTINUATION = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token)["'\\]*\s*[:=]\s*(?:\{|\[)?\s*$/i;

/** Conservative known-operation classifier, not a guarantee for unmarked business secrets. */
export function isSensitiveDetailCommand(command: string): boolean {
  return /(?:\b(?:auth\s+(?:login|token)|login|credential(?:s)?|printenv|env\s*$)|(?:^|[\s/'"])(?:\.env(?:\b|\.)|auth\.json|credentials(?:\.json)?|\.netrc|id_rsa|id_ed25519)(?:\b|['"])|--(?:token|password|secret|api-key)(?:\s|=))/i.test(command);
}

/** Holds a bounded incomplete line so a credential split across deltas is never published early. */
export class DetailSanitizer {
  private pending = '';
  private droppingLongLine = false;
  private privateKey = false;
  private sensitiveContinuation = false;
  private redacted = false;
  private readonly maxLineChars: number;
  private readonly sensitiveOperation: boolean;

  constructor(options: { maxLineChars?: number; sensitiveOperation?: boolean; discardUntilNewline?: boolean; privateKey?: boolean; sensitiveContinuation?: boolean } = {}) {
    this.maxLineChars = options.maxLineChars ?? 4096;
    if (!Number.isSafeInteger(this.maxLineChars) || this.maxLineChars < 1) throw new Error('Invalid detail line budget');
    this.sensitiveOperation = options.sensitiveOperation ?? false;
    this.droppingLongLine = options.discardUntilNewline ?? false;
    this.privateKey = options.privateKey ?? false;
    // A lost partial line may have been a credential key with its value on following lines.
    this.sensitiveContinuation = options.sensitiveContinuation === true || options.discardUntilNewline === true;
    this.redacted = this.droppingLongLine || this.privateKey || this.sensitiveOperation || this.sensitiveContinuation;
  }

  get bufferedChars(): number { return this.pending.length; }
  /** Non-mutating safe preview for progress cards; raw incomplete lines remain only in bounded memory. */
  preview(): SanitizedDetailText {
    if (!this.pending || this.droppingLongLine || this.sensitiveOperation) return { text: '', redacted: this.redacted };
    const copy = new DetailSanitizer({ maxLineChars: this.maxLineChars, privateKey: this.privateKey, sensitiveContinuation: this.sensitiveContinuation });
    const safe = copy.push(`${this.pending}\n`);
    return { text: safe.text.replace(/\n$/, ''), redacted: this.redacted || safe.redacted };
  }
  /** Safe resume flags only: incomplete raw lines are deliberately never persisted. */
  get resumeState(): { pendingLine: boolean; privateKey: boolean; sensitiveContinuation: boolean } {
    return { pendingLine: this.pending.length > 0 || this.droppingLongLine, privateKey: this.privateKey,
      sensitiveContinuation: this.sensitiveContinuation || SENSITIVE_CONTINUATION.test(this.pending) };
  }

  push(delta: string): SanitizedDetailText {
    if (this.sensitiveOperation) { this.redacted = true; return { text: '', redacted: true }; }
    const output: string[] = [];
    // Do not concatenate unbounded delta + pending, nor split huge output into a line array.
    let offset = 0;
    while (offset < delta.length) {
      const newline = delta.indexOf('\n', offset);
      const end = newline < 0 ? delta.length : newline;
      const length = end - offset;
      if (!this.droppingLongLine && this.pending.length + length > this.maxLineChars) {
        this.pending = '';
        this.droppingLongLine = true;
        this.redacted = true;
        output.push(LONG_LINE);
      }
      if (!this.droppingLongLine) this.pending += delta.slice(offset, end);
      if (newline >= 0) {
        if (this.droppingLongLine) output.push('\n');
        else output.push(this.sanitizeLine(this.pending), '\n');
        this.pending = '';
        this.droppingLongLine = false;
      }
      offset = newline < 0 ? delta.length : newline + 1;
    }
    return { text: output.join(''), redacted: this.redacted };
  }

  finish(): SanitizedDetailText {
    const text = this.pending ? this.sanitizeLine(this.pending) : '';
    this.pending = '';
    this.droppingLongLine = false;
    return { text, redacted: this.redacted };
  }

  private sanitizeLine(line: string): string {
    const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (this.sensitiveContinuation) { this.redacted = true; return HIDDEN; }
    if (/-----BEGIN .*PRIVATE KEY-----/.test(clean)) this.privateKey = true;
    if (this.privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(clean)) this.privateKey = false;
      this.redacted = true;
      return HIDDEN;
    }
    if (SENSITIVE_LINE.test(clean)) {
      if (SENSITIVE_CONTINUATION.test(clean)) this.sensitiveContinuation = true;
      this.redacted = true; return HIDDEN;
    }
    if (clean !== line) this.redacted = true;
    return clean;
  }
}

export function sanitizeDetailText(text: string): SanitizedDetailText {
  const stream = new DetailSanitizer();
  const first = stream.push(text);
  const last = stream.finish();
  return { text: first.text + last.text, redacted: last.redacted };
}

/** Complete public answers are already in memory: retain ordinary long lines, hide known credentials. */
export function sanitizePublicAnswerText(text: string): string {
  const stream = new DetailSanitizer({ maxLineChars: Math.max(4096, text.length) });
  return stream.push(text).text + stream.finish().text;
}
