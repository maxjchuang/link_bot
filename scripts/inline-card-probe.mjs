import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import { LarkLongConnectionGateway } from '../dist/src/feishu/FeishuGateway.js';
import { renderStructuredTurnCard } from '../dist/src/livecards/StructuredTurnCardRenderer.js';
import { renderStructuredFinalCard } from '../dist/src/livecards/StructuredFinalCardRenderer.js';
import { inlineCardRegions } from '../dist/src/livecards/InlineTaskCardLayout.js';
import { isTimelineTaskCard } from '../dist/src/livecards/TimelineTaskCardLayout.js';
import { emptyInlineDetails } from '../dist/src/details/InlineTurnDetails.js';

const [mode, first, actor] = process.argv.slice(2);
const path = '.link-bot/inline-native-probe.json';
const stages = ['progress', 'details', 'completed'];
if (!['validate', 'send', 'resume-send', 'advance'].includes(mode) || mode === 'send' && (!/^om_[\w-]+$/.test(first ?? '') || !/^ou_[\w-]+$/.test(actor ?? ''))
  || mode === 'advance' && !stages.includes(first)) {
  console.log('Usage (after npm run build):\n  node scripts/inline-card-probe.mjs validate\n  node scripts/inline-card-probe.mjs send SOURCE_MESSAGE_ID ACTOR_OPEN_ID\n  node scripts/inline-card-probe.mjs resume-send\n  node scripts/inline-card-probe.mjs advance progress|details|completed\nOnly send targets the verified source private chat. All content is inert demo data.');
  process.exit(mode && mode !== '--help' ? 1 : 0);
}
const config = JSON.parse(await readFile('.link-bot/config.json', 'utf8'));
const silent = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map((key) => [key, () => undefined]));
const client = new lark.Client({ ...config.feishu, logger: silent, loggerLevel: lark.LoggerLevel.off });
const gateway = new LarkLongConnectionGateway(config.feishu.appId, config.feishu.appSecret, { client });
const save = async (value) => {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};
function fixture(stage = 'initial') {
  const inlineDetails = emptyInlineDetails('available');
  for (const category of ['process', 'commands', 'files']) inlineDetails.categories[category] = { total: stage === 'details' || stage === 'completed' ? 2 : 1,
    items: [{ title: `${category === 'process' ? '公开进度' : category === 'commands' ? 'npm test' : 'example.ts'}（演示，未执行）`,
      metadata: '仅为验收样例，不是真实执行结果', text: stage === 'details' || stage === 'completed' ? '预览内容已通过局部更新追加。' : '初始预览内容。', limited: false }] };
  // Two retained demo rows really exist in the synthetic fixture when its count says two.
  for (const category of ['process', 'commands', 'files']) if (inlineDetails.categories[category].total === 2)
    inlineDetails.categories[category].items.push({ title: '第二条演示记录', metadata: '只测试局部更新', text: '不会执行命令或修改项目文件。', limited: false });
  inlineDetails.timeline = { total: Object.values(inlineDetails.categories).reduce((n, page) => n + page.total, 0),
    items: [0,1].flatMap(index => ['process','commands','files'].flatMap((category, n) => {
      const item = inlineDetails.categories[category].items[index];
      return item ? [{...item,category,entryId:(index * 3 + n + 1).toString(16).padStart(32,'0'),receivedAt:'2026-10-22T00:00:00Z',failed:false,
        ...(category==='commands'?{commandStatus:'succeeded'}:{})}] : [];
    })) };
  const common = { label: '原卡折叠验收样例 · 演示数据，不执行任务', inlineDetails, elapsedMs:1900000,
    footer: ['模型：演示值', '思考强度：演示值', '模式：验收样例', '上下文：未使用', '任务累计：未执行任务', `已运行：${stage === 'initial' ? '初始样例' : '已局部更新'}`] };
  if (stage === 'completed') return renderStructuredFinalCard({ ...common, phase: 'completed',
    answer: '**验收状态：已完成（演示）**\n\n这是完成态验收样例，不代表真实任务结果。请确认没有大标题和底栏，完成后执行过程默认收起，展开命令组后可直接看到原文和输出。', hasMore: false });
  return renderStructuredTurnCard({ ...common, elapsedMs: 0, snapshot: { phase: 'running', processPreviews: [{ source: 'progress', itemId: 'demo',
    text: stage === 'initial' ? '运行中执行过程默认展开，完成后默认收起；命令组始终默认折叠，展开后直接看到命令和输出。'
      : stage === 'progress' ? '进度及底栏已局部更新；请检查折叠区是否仍展开。' : '详情内容已局部更新；请检查折叠区是否仍展开。' }] } });
}
async function privateSource(sourceId, userId) {
  const response = await client.im.message.get({ path: { message_id: sourceId } });
  const item = response.code === 0 && response.data?.items?.[0];
  if (!item || item.deleted || item.sender?.id !== userId || item.sender?.sender_type !== 'user') throw new Error('source_not_verified');
  const chat = await client.im.chat.get({ path: { chat_id: item.chat_id } });
  if (chat.code !== 0 || chat.data?.chat_mode !== 'p2p') throw new Error('source_not_private');
  return item.chat_id;
}
async function verifyMessage(messageId, chatId, expected, timelineLayout = false) {
  const response = await client.im.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'user_card_content' } });
  const item = response.code === 0 && response.data?.items?.[0];
  if (!item || item.chat_id !== chatId || item.deleted) throw new Error('probe_readback_unavailable');
  const card = JSON.parse(item.body.content), text = JSON.stringify(card);
  const footer = card.body?.elements?.find((element) => element.element_id === 'app_server_footer');
  if (timelineLayout && expected === 'completed') {
    const panel = card.body?.elements?.find(element => element.element_id === 'turn_timeline');
    if (footer || card.header || !panel || panel.expanded !== false
      || card.body.elements.indexOf(panel) === 0) throw new Error('probe_terminal_layout_readback_failed');
  } else if (!['模型', '思考强度', '模式', '上下文', '任务累计', '已运行'].every((label) => JSON.stringify(footer).includes(label))) throw new Error('probe_footer_readback_failed');
  if (expected === 'completed' && (!text.includes('验收状态：已完成') || text.includes('Codex 正在工作'))) throw new Error('probe_completion_readback_failed');
  if (timelineLayout && (!isTimelineTaskCard(card) || card.header)) throw new Error('probe_timeline_readback_failed');
}
try {
  if (mode === 'validate') {
    const { cardId } = await gateway.createCardKitEntity(fixture());
    await gateway.updateCardKitRegions({ cardId, regions: inlineCardRegions(fixture('progress')), sequence: 2, uuid: randomUUID() });
    await gateway.replaceCardKitEntity({ cardId, card: fixture('completed'), sequence: 3, uuid: randomUUID() });
    console.log(JSON.stringify({ apiValidated: true, unpublished: true, clientStateValidated: false }));
  } else if (mode === 'send') {
    // Preserve an existing receipt rather than silently orphaning a client-acceptance session.
    try { await readFile(path); throw new Error('probe_already_exists_use_advance'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const chatId = await privateSource(first, actor), card = fixture();
    const { cardId } = await gateway.createCardKitEntity(card);
    const sendUuid = randomUUID();
    const state = { version: 1, cardId, chatId, sourceMessageId: first, actorId: actor, sendUuid, sequence: 2, card };
    await save(state);
    const receipt = await gateway.sendCardKitEntityToTarget({ chatId, replyToMessageId: first }, cardId, sendUuid);
    await save({ ...state, messageId: receipt.messageId });
    await verifyMessage(receipt.messageId, chatId, 'initial', true);
    console.log(JSON.stringify({ sent: true, messageId: receipt.messageId, clientStateValidated: false }));
  } else if (mode === 'resume-send') {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.cardId || !state.sendUuid) throw new Error('invalid_probe_receipt');
    if (await privateSource(state.sourceMessageId, state.actorId) !== state.chatId) throw new Error('source_changed');
    const receipt = state.messageId ? { messageId: state.messageId }
      : await gateway.sendCardKitEntityToTarget({ chatId: state.chatId, replyToMessageId: state.sourceMessageId }, state.cardId, state.sendUuid);
    await save({ ...state, messageId: receipt.messageId });
    console.log(JSON.stringify({ sent: true, messageId: receipt.messageId, clientStateValidated: false }));
  } else {
    const state = JSON.parse(await readFile(path, 'utf8'));
    if (state.version !== 1 || !state.messageId || !state.cardId || !Number.isSafeInteger(state.sequence)) throw new Error('invalid_probe_receipt');
    if (await privateSource(state.sourceMessageId, state.actorId) !== state.chatId) throw new Error('source_changed');
    const target = await client.im.message.get({ path: { message_id: state.messageId } });
    if (target.code !== 0 || target.data?.items?.[0]?.chat_id !== state.chatId || target.data.items[0].deleted) throw new Error('probe_message_not_verified');
    if (state.intent && state.intent.stage !== first) throw new Error('retry_pending_probe_stage_first');
    const card = fixture(first), old = new Map(inlineCardRegions(state.card).map((region) => [region.elementId, JSON.stringify(region.element)]));
    const intent = state.intent ?? { stage: first, card, sequence: state.sequence, uuid: randomUUID(),
      replaceCard: JSON.stringify(state.card.header) !== JSON.stringify(card.header)
        || isTimelineTaskCard(state.card) !== isTimelineTaskCard(card)
        || state.card.body.elements.find(element=>element.element_id==='turn_timeline')?.expanded !== card.body.elements.find(element=>element.element_id==='turn_timeline')?.expanded,
      regions: inlineCardRegions(card).filter((region) => old.get(region.elementId) !== JSON.stringify(region.element)) };
    if (intent.replaceCard || intent.regions.length) {
      await save({ ...state, intent });
      if (intent.replaceCard) await gateway.replaceCardKitEntity({ cardId: state.cardId, card: intent.card, sequence: intent.sequence, uuid: intent.uuid });
      else await gateway.updateCardKitRegions({ cardId: state.cardId, ...intent });
      await verifyMessage(state.messageId, state.chatId, first, isTimelineTaskCard(intent.card));
      await save({ ...state, intent: undefined, card: intent.card, sequence: intent.sequence + 1, stage: first });
    }
    console.log(JSON.stringify({ updated: true, stage: first, updateMode: intent.replaceCard ? 'whole_card' : 'regions', regions: intent.regions.map((region) => region.elementId), clientStateValidated: false }));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: /^[a-z_]+$/.test(error.message ?? '') ? error.message : 'native_probe_failed', category: error.category }));
  process.exitCode = 1;
}
// The SDK's unused WebSocket helper owns a housekeeping timer. This standalone
// probe exits only after all API calls and private receipt writes have completed.
await Promise.all([new Promise((resolve) => process.stdout.write('', resolve)), new Promise((resolve) => process.stderr.write('', resolve))]);
process.exit(process.exitCode ?? 0);
