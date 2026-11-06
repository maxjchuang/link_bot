import { basename } from 'node:path';

export interface SourceInspection {
  fileName: string;
  line: number;
  permalink?: string;
  snippet?: { startLine: number; lines: string[] };
  diff?: string;
}

export interface SourceReferenceInspector {
  inspect(taskId: string, path: string, line: number): Promise<SourceInspection | undefined>;
}

const MAX_REFERENCES = 8;
const MAX_SNIPPETS = 3;
const RESOLUTION_DEADLINE_MS = 10_000;
const MAX_PARSE_LINE_LENGTH = 16_384;

export class SourceReferenceService {
  constructor(private readonly inspector: SourceReferenceInspector) {}

  async resolveMarkdown(taskId: string, markdown: string): Promise<string> {
    const deadline = Date.now() + RESOLUTION_DEADLINE_MS;
    let fence: MarkdownFence | undefined;
    let references = 0;
    const snippets: string[] = [];
    const snippetNumbers = new Map<string, number>();
    const inspected = new Map<string, SourceInspection | undefined>();
    const output: string[] = [];
    for (const line of markdown.split('\n')) {
      const nextFence = advanceMarkdownFence(line, fence);
      if (nextFence !== fence) {
        fence = nextFence;
        output.push(line);
        continue;
      }
      if (fence) {
        output.push(line);
        continue;
      }
      if (line.length > MAX_PARSE_LINE_LENGTH) {
        output.push(sanitizeOversizedLine(line));
        continue;
      }
      const resolved: string[] = [];
      for (const segment of splitInlineCode(line)) {
        if (segment.code) {
          resolved.push(segment.text);
          continue;
        }
        let next = '';
        let cursor = 0;
        for (const match of markdownLinks(segment.text)) {
          const target = parseLocalSourceTarget(match.href);
          if (!target && !isLocalLinkTarget(match.href)) continue;
          next += segment.text.slice(cursor, match.start);
          cursor = match.end;
          const label = match.label;
          if (!target) {
            next += `${label}（本地路径不可访问）`;
            continue;
          }
          const fallback = `${label}（\`${basename(target.path)}${target.line ? `:${target.line}` : ''}\`，本地路径）`;
          if (match.image || !target.line || references >= MAX_REFERENCES) {
            next += fallback;
            continue;
          }
          references += 1;
          const key = `${target.path}:${target.line}`;
          if (!inspected.has(key)) {
            inspected.set(key, await inspectBeforeDeadline(this.inspector, taskId, target.path, target.line, deadline));
          }
          const result = inspected.get(key);
          if (result?.permalink) {
            next += `[${label}](${result.permalink})`;
            continue;
          }
          const existingSnippet = snippetNumbers.get(key);
          if (existingSnippet) {
            next += `${label}（\`${result?.fileName ?? basename(target.path)}:${target.line}\`，见片段 ${existingSnippet}）`;
            continue;
          }
          if (result && snippets.length < MAX_SNIPPETS && (result.diff || result.snippet)) {
            const number = snippets.length + 1;
            snippetNumbers.set(key, number);
            snippets.push(formatSnippet(number, result));
            next += `${label}（\`${result.fileName}:${result.line}\`，见片段 ${number}）`;
          } else {
            next += fallback;
          }
        }
        resolved.push(next ? next + segment.text.slice(cursor) : segment.text);
      }
      output.push(resolved.join(''));
    }
    return sanitizeUnresolvedSourceLinks(output.join('\n'))
      + (snippets.length ? `\n\n${snippets.join('\n\n')}` : '');
  }
}

async function inspectBeforeDeadline(
  inspector: SourceReferenceInspector, taskId: string, path: string, line: number, deadline: number,
): Promise<SourceInspection | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return undefined;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), remaining);
    Promise.resolve().then(() => inspector.inspect(taskId, path, line))
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch(() => { clearTimeout(timer); resolve(undefined); });
  });
}

export function parseLocalSourceTarget(value: string): { path: string; line?: number } | undefined {
  let path = unwrapMarkdownTarget(value);
  if (/^https?:\/\/workspace\//i.test(path)) path = path.replace(/^https?:\/\/workspace/i, '/workspace');
  if (/^file:\/\/\/workspace\//i.test(path)) path = path.replace(/^file:\/\//i, '');
  if (!path.startsWith('/workspace/') || path.split('/').includes('..')) return undefined;
  const match = /^(.*?)(?::([1-9]\d{0,6}))?$/.exec(path);
  if (!match?.[1]) return undefined;
  return { path: match[1], ...(match[2] ? { line: Number(match[2]) } : {}) };
}

export function sanitizeUnresolvedSourceLinks(markdown: string): string {
  let fence: MarkdownFence | undefined;
  return markdown.split('\n').map((line) => {
    const nextFence = advanceMarkdownFence(line, fence);
    if (nextFence !== fence) {
      fence = nextFence;
      return line;
    }
    if (fence) return line;
    if (line.length > MAX_PARSE_LINE_LENGTH) return sanitizeOversizedLine(line);
    return splitInlineCode(line).map((segment) => {
      if (segment.code) return segment.text;
      let next = '';
      let cursor = 0;
      for (const match of markdownLinks(segment.text)) {
        const target = parseLocalSourceTarget(match.href);
        if (!target && !isLocalLinkTarget(match.href)) continue;
        next += segment.text.slice(cursor, match.start);
        next += target
          ? `${match.label}（\`${basename(target.path)}${target.line ? `:${target.line}` : ''}\`，本地路径）`
          : `${match.label}（本地路径不可访问）`;
        cursor = match.end;
      }
      const withoutMarkdownLinks = next ? next + segment.text.slice(cursor) : segment.text;
      return withoutMarkdownLinks.replace(/(?:https?:\/\/workspace|file:\/\/\/workspace)\/[A-Za-z0-9._/%:-]+/gi, (url) => {
        const target = parseLocalSourceTarget(url);
        return target ? `\`${basename(target.path)}${target.line ? `:${target.line}` : ''}\`（本地路径）` : '本地路径不可访问';
      });
    }).join('');
  }).join('\n');
}

function sanitizeOversizedLine(line: string): string {
  return splitInlineCode(line).map((segment) => {
    if (segment.code) return segment.text;
    return segment.text
      .replace(/!?\[([^\]\n]{1,200})\]\(\s*<?(?:\/workspace\/|https?:\/\/workspace\/|file:\/\/\/workspace\/)/gi,
        (_match, label: string) => `${label}（本地路径不可访问）`)
      .replace(/(?:https?:\/\/workspace|file:\/\/\/workspace)\/[A-Za-z0-9._/%:-]+/gi,
        '本地路径不可访问');
  }).join('');
}

export interface MarkdownFence { marker: '`' | '~'; length: number }

export function advanceMarkdownFence(line: string, current: MarkdownFence | undefined): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return current;
  const marker = match[1]![0] as MarkdownFence['marker'];
  const length = match[1]!.length;
  if (!current) return { marker, length };
  return marker === current.marker && length >= current.length && !match[2]!.trim()
    ? undefined : current;
}

interface MarkdownLink { start: number; end: number; image: boolean; label: string; href: string }

function markdownLinks(line: string): MarkdownLink[] {
  const matches: MarkdownLink[] = [];
  const start = /(!?)\[([^\]\n]{1,200})\]\(/g;
  for (const match of line.matchAll(start)) {
    const bodyStart = match.index! + match[0].length;
    let depth = 1;
    let quote = '';
    let end = bodyStart;
    for (; end < line.length; end += 1) {
      const char = line[end]!;
      if (char === '\\') { end += 1; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if ((char === '"' || char === "'") && /\s/.test(line[end - 1] ?? '')) { quote = char; continue; }
      if (char === '(') depth += 1;
      if (char === ')' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    const body = line.slice(bodyStart, end).trim();
    const href = body.startsWith('<')
      ? body.slice(0, body.indexOf('>') + 1)
      : body.match(/^[^\s]+/)?.[0] ?? '';
    matches.push({ start: match.index!, end: end + 1, image: Boolean(match[1]), label: match[2]!, href });
  }
  return matches;
}

function splitInlineCode(line: string): Array<{ text: string; code: boolean }> {
  const segments: Array<{ text: string; code: boolean }> = [];
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening < 0) break;
    let length = 1;
    while (line[opening + length] === '`') length += 1;
    const closing = line.indexOf('`'.repeat(length), opening + length);
    if (closing < 0) break;
    segments.push({ text: line.slice(cursor, opening), code: false });
    segments.push({ text: line.slice(opening, closing + length), code: true });
    cursor = closing + length;
  }
  segments.push({ text: line.slice(cursor), code: false });
  return segments;
}

function isLocalLinkTarget(value: string): boolean {
  return /^(?:\/workspace\/|https?:\/\/workspace\/|file:\/\/\/workspace\/)/i.test(unwrapMarkdownTarget(value));
}

function unwrapMarkdownTarget(value: string): string {
  return value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
}

function formatSnippet(number: number, result: SourceInspection): string {
  const raw = result.diff
    ? result.diff.split('\n').slice(0, 30).join('\n')
    : result.snippet!.lines.slice(0, 30).map((line, index) =>
      `${result.snippet!.startLine + index} | ${line}`).join('\n');
  const safe = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/```/g, '`​``').slice(0, 1_500);
  return `片段 ${number} · ${result.fileName}:${result.line}\n\n\`\`\`text\n${safe}\n\`\`\``;
}
