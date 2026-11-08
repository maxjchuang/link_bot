# Feishu app permissions

Checked against the current Link Bot source and official Feishu API documentation on 2026-11-08.
Import [feishu-permissions.json](feishu-permissions.json) under **Permissions & Scopes → Batch import/export scopes** in the Feishu developer console. Submit the requested scopes for approval and publish an updated app version. Importing the JSON alone does not activate permissions or configure event subscriptions.

The file covers the manager's implemented bot features, including conversation history, media, live cards, and reactions. It contains application (`tenant`) permissions only. Sandbox tools use separately configured user credentials and request permissions according to the task; this file does not preauthorize every command a general agent might run.

| Scope | Purpose in Link Bot | When needed |
| --- | --- | --- |
| `im:message:send_as_bot` | Send/reply to text, rich text, cards, and attachment messages; update message cards; recall the bot's own messages | Replies and card delivery |
| `im:message.p2p_msg:readonly` | Receive messages sent directly to the bot | Private chat |
| `im:message.group_at_msg:readonly` | Receive user mentions of the bot | Group/topic mentions; also covered by receiving all group user messages |
| `im:chat:read` | Query chat metadata and distinguish private/group/topic conversations | Group routing and access checks |
| `im:chat.members:read` | Resolve exact member names and verify membership before displaying conversation details | Member lookup and detail authorization |
| `im:message:readonly` | Fetch specific messages, conversation history, and message attachments | Source verification, context, history, attachments |
| `im:message.group_msg` | Supplement message-read permissions for group message retrieval; receive group user messages | Group/topic history and ambient context; **sensitive: allows access to all user messages in groups the bot belongs to** |
| `cardkit:card:write` | Create, replace, and incrementally update CardKit card entities | Live task cards |
| `im:resource` | Upload images and files | Image/file output and private authorization QR images; message downloads use the message-read permission above |
| `im:message.reactions:write_only` | Add message emoji reactions | Reaction feedback |

For a deployment without history or media, some feature-specific scopes can be omitted, but disabling the matching code paths is necessary. In particular, the current code uses message and membership lookups for access checks as well as context, so removing read scopes can block those operations. No additional historical `im:message:update`, `im:message:recall`, or broad `im:message` scope is needed: the official update/recall APIs accept `im:message:send_as_bot`. The code uses `open_id`, so it does not require `contact:user.employee_id:readonly`.

## Separate console settings

- Enable the application's bot capability and give it the intended user availability range.
- Under **Events & Callbacks**, choose **long connection** and subscribe to `im.message.receive_v1` (Receive message v2.0).
- Under callback subscriptions, enable `card.action.trigger` for buttons and approvals. This callback has no additional scope requirement.
- Add the bot to the intended group/topic group and allow it to speak. Link Bot's own user/chat allowlists still apply.
- Publish the app version after scope or subscription changes; complete any administrator approval required by the tenant.

## Official references

- [Permission application and batch import](https://open.feishu.cn/document/ukTMukTMukTM/uQjN3QjL0YzN04CN2cDN)
- [Receive message](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive.md)
- [Send message](https://open.feishu.cn/document/server-docs/im-v1/message/create.md), [reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md)
- [Get message](https://open.feishu.cn/document/server-docs/im-v1/message/get.md), [history](https://open.feishu.cn/document/server-docs/im-v1/message/list.md), [download message resource](https://open.feishu.cn/document/server-docs/im-v1/message/get-2.md)
- [Get chat](https://open.feishu.cn/document/server-docs/group/chat/get-2.md), [list members](https://open.feishu.cn/document/server-docs/group/chat-member/get.md)
- [Update message card](https://open.feishu.cn/document/server-docs/im-v1/message-card/patch.md), [recall message](https://open.feishu.cn/document/server-docs/im-v1/message/delete.md)
- [Create card entity](https://open.feishu.cn/document/cardkit-v1/card/create.md), [batch update](https://open.feishu.cn/document/cardkit-v1/card/batch_update.md)
- [Upload image](https://open.feishu.cn/document/server-docs/im-v1/image/create.md), [upload file](https://open.feishu.cn/document/server-docs/im-v1/file/create.md), [add reaction](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create.md)
- [Card interaction callback](https://open.feishu.cn/document/feishu-cards/card-callback-communication.md)
