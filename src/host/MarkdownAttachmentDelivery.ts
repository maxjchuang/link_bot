import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';

interface MarkdownAttachmentGateway {
  uploadFile(data: Buffer, filename: string): Promise<string>;
  sendMediaToTarget(target: FeishuReplyTarget, media: {
    kind: 'file'; resourceKey: string; uuid: string;
  }): Promise<unknown>;
}

/** Deliver local Markdown documents before presenting the final reply. */
export async function deliverMarkdownAttachments(
  text: string, projectRoot: string, target: FeishuReplyTarget, gateway: MarkdownAttachmentGateway,
): Promise<string> {
  const links = [...text.matchAll(/\[([^\]\n]+)\]\((<[^>]+>|[^)\n]+)\)/g)];
  const delivered = new Map<string, string>();
  let output = '';
  let cursor = 0;
  for (const link of links) {
    const rawPath = link[2]!.replace(/^<|>$/g, '').trim().replace(/:\d+(?:-\d+)?$/, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(rawPath) || !/\.md$/i.test(rawPath)) continue;
    output += text.slice(cursor, link.index);
    cursor = link.index! + link[0].length;
    try {
      const decodedPath = decodeURIComponent(rawPath);
      const filePath = await realpath(isAbsolute(decodedPath) ? decodedPath : resolve(projectRoot, decodedPath));
      const docsRoot = await realpath(resolve(projectRoot, 'docs'));
      const inside = relative(docsRoot, filePath);
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw new Error('Markdown document must be inside the project docs directory.');
      }
      const metadata = await stat(filePath);
      if (!metadata.isFile() || metadata.size > 10 * 1024 * 1024) throw new Error('Markdown attachment exceeds delivery limits.');
      let filename = delivered.get(filePath);
      if (!filename) {
        filename = basename(filePath);
        const data = await readFile(filePath);
        const resourceKey = await gateway.uploadFile(data, filename);
        const uuid = createHash('sha256').update(JSON.stringify(target)).update(filePath).update(data).digest('hex').slice(0, 32);
        await gateway.sendMediaToTarget(target, { kind: 'file', resourceKey, uuid });
        delivered.set(filePath, filename);
      }
      output += `${link[1]}（已发送 Markdown 附件：${filename}）`;
    } catch (error) {
      console.error('Markdown attachment delivery failed.', error);
      output += `${link[1]}（Markdown 附件发送失败，请重试）`;
    }
  }
  return output + text.slice(cursor);
}
