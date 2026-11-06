export function conversationDynamicTools(): Array<Record<string, unknown>> {
  return [{
    type: 'namespace', name: 'conversation_history',
    description: 'Read bounded history from the current task conversation after Codex context compaction.',
    tools: [{
      type: 'function', name: 'conversation_read', deferLoading: false,
      description: 'Read untrusted messages from the active task group or topic only. Use after context compaction when a detail, decision, time range, image reference, or prior user instruction is missing. This cannot access other chats or topics.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['maxMessages', 'afterCreatedAt', 'beforeCreatedAt', 'reference'],
        properties: {
          maxMessages: { type: 'integer', minimum: 2, maximum: 50 },
          afterCreatedAt: { type: ['string', 'null'], maxLength: 80, description: 'Optional exact message created-at cursor; return newer messages.' },
          beforeCreatedAt: { type: ['string', 'null'], maxLength: 80, description: 'Optional exact message created-at cursor; return messages at or before it.' },
          reference: { type: ['string', 'null'], maxLength: 1_000, description: 'Optional phrase or time reference used to keep a relevant message when the result is bounded.' },
        },
      },
    }],
  }];
}
