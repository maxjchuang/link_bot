import { describe, expect, it } from 'vitest';
import { selectConversationProject } from '../../src/projects/ConversationProjectSelector.js';

const projects = [
  { id: 'link-bot', name: 'Link Bot', path: '/projects/link_bot', description: 'Feishu Link Bot platform', codexArgs: [] },
  { id: 'example-web', name: 'Example Assistant Web', path: '/projects/chatbot', repositoryPath: 'example/assistant', description: 'React frontend', codexArgs: [] },
  { id: 'example-api', name: 'Example Assistant', path: '/projects/example-api', repositoryPath: 'example/example-api', description: 'Go service runtime', codexArgs: [] },
  { id: 'backend-core', name: 'Example Backend Core', path: '/projects/backend-core', description: 'Go backend services', codexArgs: [] },
];

describe('selectConversationProject', () => {
  it('uses the topic group name and root message to choose the unique backend project', () => {
    expect(selectConversationProject(projects, {
      chatName: 'Example Assistant 运行问题反馈群',
      requestText: '帮我查这个运行日志 ID',
      context: {
        scope: 'topic', chatId: 'oc_1', threadId: 'omt_1', truncated: false, fetchedAt: '',
        messages: [{ messageId: 'om_root', createdAt: '', messageType: 'text', text: 'example-api 服务运行失败' }],
      },
    })?.id).toBe('example-api');
  });

  it('does not guess when only a shared product phrase is present', () => {
    expect(selectConversationProject(projects, { requestText: '看看 chatbot 的问题' })).toBeUndefined();
  });

  it('uses the first root-message project as a multi-project workspace anchor instead of favoring more aliases', () => {
    expect(selectConversationProject(projects, {
      chatName: 'Chatbot 开发广场', requestText: '帮我查这个运行日志 ID',
      context: {
        scope: 'topic', chatId: 'oc_1', threadId: 'omt_1', truncated: false, fetchedAt: '',
        messages: [{
          messageId: 'om_root', createdAt: '', messageType: 'post',
          text: '相关项目：example-api；backend-core；chatbot 前端',
        }],
      },
    })?.id).toBe('example-api');
  });

  it('prefers an explicit frontend implementation target over IDL and backend reference links', () => {
    const withIdl = [
      ...projects,
      { id: 'example-idl', name: 'Example Protocols', path: '/projects/idl', repositoryPath: 'example/protocols', description: 'IDL protocol definitions', codexArgs: [] },
    ];
    expect(selectConversationProject(withIdl, {
      chatName: 'Chatbot 开发广场',
      requestText: '帮我在 Example Assistant Web 前端仓库，按照 PRD、技术方案和 IDL 协议，实现前端的模型切换功能，后端 go 仓库的 MR 仅作为参考',
      context: {
        scope: 'topic', chatId: 'oc_1', threadId: 'omt_1', truncated: false, fetchedAt: '',
        messages: [{
          messageId: 'om_root', createdAt: '', messageType: 'text',
          text: 'IDL：https://github.com/example/protocols/blob/master/example.thrift 后端参考：https://github.com/example/example-api/pull/2754',
        }],
      },
    })?.id).toBe('example-web');
  });

  it('recovers the explicit frontend target from topic history for a generic continuation', () => {
    const withIdl = [
      ...projects,
      { id: 'example-idl', name: 'Example Protocols', path: '/projects/idl', repositoryPath: 'example/protocols', description: 'IDL protocol definitions', codexArgs: [] },
    ];
    expect(selectConversationProject(withIdl, {
      chatName: 'Chatbot 开发广场',
      requestText: '继续任务',
      context: {
        scope: 'topic', chatId: 'oc_1', threadId: 'omt_1', truncated: false, fetchedAt: '',
        messages: [{
          messageId: 'om_root', createdAt: '1', messageType: 'post',
          text: '需求：帮我在 Example Assistant Web 前端仓库，按照 PRD、技术方案和 IDL 协议，实现前端的模型切换功能；后端 IDL：https://github.com/example/protocols/blob/master/example.thrift；后端 MR 仅作为参考：https://github.com/example/example-api/pull/2754',
        }],
      },
    })?.id).toBe('example-web');
  });
});
