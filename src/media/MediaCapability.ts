export const MEDIA_TOOL_REVISION = 1;

export function mediaDynamicTools(): Array<Record<string, unknown>> {
  return [{
    type: 'namespace', name: 'artifacts',
    description: 'Publish generated files back to the current Link Bot conversation without changing the target chat.',
    tools: [{
      type: 'function', name: 'artifact_publish', deferLoading: false,
      description: [
        'Register one generated file for delivery to the current Feishu conversation.',
        'Use this when the user asks you to send, attach, return, or provide a generated image or downloadable file.',
        'Always publish generated Markdown design documents as file attachments, even when the user did not explicitly ask for an attachment. Do not return local Markdown links.',
        'Publish an existing file from /workspace/.linkbot/artifacts/ directly, or place any other file in the current task .linkbot/outbox directory first.',
        'Call this once per file before your final answer. A local path or Markdown image link does not send the file.',
        'The target conversation is selected by Link Bot and cannot be changed.',
        'Do not claim that a file was registered unless this tool succeeds.',
      ].join(' '),
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['path', 'disposition', 'displayName'],
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 2_000 },
          disposition: { type: 'string', enum: ['auto', 'image', 'file'] },
          displayName: { type: 'string', minLength: 1, maxLength: 255 },
          caption: { type: 'string', maxLength: 1_000 },
        },
      },
    }],
  }];
}

export function mediaDeliveryGuidance(taskId: string, runtimeMode: string | undefined, sandboxWorkspaceLayout?: 'project'): string {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120);
  const outbox = runtimeMode === 'user-sandbox'
    ? sandboxWorkspaceLayout === 'project'
      ? `/workspace/.linkbot/tasks/${safeTaskId}/outbox/`
      : `/workspace/tasks/${safeTaskId}/.linkbot/outbox/`
    : '/workspace/.linkbot/outbox/';
  return [
    '<manager_media_delivery>',
    'When the requester asks to receive a local image or file, call artifact_publish once per file before the final answer.',
    'Always deliver generated Markdown design documents as .md file attachments with artifact_publish; do not use local Markdown links in the final answer.',
    'Files under /workspace/.linkbot/artifacts/ can be published directly.',
    `For files elsewhere, copy them to ${outbox} and publish the copied file.`,
    'A local filesystem path or Markdown image link is not a Feishu attachment.',
    '</manager_media_delivery>',
  ].join('\n');
}
