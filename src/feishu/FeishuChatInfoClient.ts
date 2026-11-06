import * as lark from '@larksuiteoapi/node-sdk';

export interface FeishuChatInfoClient { get(chatId: string): Promise<{ name: string }> }

export class LarkFeishuChatInfoClient implements FeishuChatInfoClient {
  private readonly getChat: (input: { path: { chat_id: string } }) => Promise<{ code?: number; msg?: string; data?: { name?: string } }>;
  constructor(appId: string, appSecret: string, client?: { im: { v1: { chat: { get: LarkFeishuChatInfoClient['getChat'] } } } }) {
    const sdk = client ?? new lark.Client({ appId, appSecret }); this.getChat = sdk.im.v1.chat.get.bind(sdk.im.v1.chat) as LarkFeishuChatInfoClient['getChat'];
  }
  async get(chatId: string): Promise<{ name: string }> { const response = await this.getChat({ path: { chat_id: chatId } }); if (response.code && response.code !== 0) throw new Error(`Feishu chat lookup failed: ${response.code} ${response.msg ?? ''}`); return { name: response.data?.name ?? '' }; }
}
