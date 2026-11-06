import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deliverMarkdownAttachments } from '../../src/host/MarkdownAttachmentDelivery.js';
import { createTmpDir } from '../helpers/tmp.js';

const target = { chatId: 'oc_private', replyToMessageId: 'om_request' };
function gateway() {
  return { uploadFile: vi.fn(async () => 'file_key'), sendMediaToTarget: vi.fn(async () => ({})) };
}

describe('MarkdownAttachmentDelivery', () => {
  it('sends a real Markdown attachment once and replaces absolute and relative links', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/design.md'), '# 设计\n内容');
    const notifier = gateway();
    const answer = await deliverMarkdownAttachments(
      `请审阅[设计文档](${root}/docs/design.md:12)，以及[同一文档](docs/design.md)。`, root, target, notifier,
    );
    expect(notifier.uploadFile).toHaveBeenCalledTimes(1);
    expect(notifier.uploadFile).toHaveBeenCalledWith(Buffer.from('# 设计\n内容'), 'design.md');
    expect(notifier.sendMediaToTarget).toHaveBeenCalledTimes(1);
    expect(notifier.sendMediaToTarget).toHaveBeenCalledWith(target, {
      kind: 'file', resourceKey: 'file_key', uuid: expect.any(String),
    });
    expect(answer).toBe('请审阅设计文档（已发送 Markdown 附件：design.md），以及同一文档（已发送 Markdown 附件：design.md）。');
  });

  it('preserves external links and code links without uploading them', async () => {
    const notifier = gateway();
    const text = '[网页](https://example.com/design.md) [源码](src/app.ts:12)';
    expect(await deliverMarkdownAttachments(text, '/unused', target, notifier)).toBe(text);
    expect(notifier.uploadFile).not.toHaveBeenCalled();
  });

  it('removes broken links and reports delivery failures without claiming success', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs/design.md'), '# 设计');
    const notifier = gateway();
    notifier.sendMediaToTarget.mockRejectedValue(new Error('send failed'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = await deliverMarkdownAttachments('[设计](docs/design.md)', root, target, notifier);
      expect(answer).toBe('设计（Markdown 附件发送失败，请重试）');
      expect(answer).not.toContain('已发送');
    } finally { errorLog.mockRestore(); }
  });

  it('rejects symlinks outside docs and missing documents without publishing unrelated files', async () => {
    const root = await createTmpDir();
    const outside = await createTmpDir();
    await mkdir(join(root, 'docs'));
    await writeFile(join(outside, 'private.md'), 'private');
    await symlink(join(outside, 'private.md'), join(root, 'docs/link.md'));
    const notifier = gateway();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const answer = await deliverMarkdownAttachments('[越界](docs/link.md) [不存在](docs/missing.md)', root, target, notifier);
      expect(answer).toBe('越界（Markdown 附件发送失败，请重试） 不存在（Markdown 附件发送失败，请重试）');
      expect(notifier.uploadFile).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); }
  });
});
