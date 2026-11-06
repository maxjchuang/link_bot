const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

export type HostTimeDiagnosticIntent =
  | { kind: 'none' }
  | { kind: 'invalid'; reply: string }
  | { kind: 'future'; reply: string }
  | { kind: 'diagnose'; date: string; time: string; target: string; prompt: string };

export function parseHostTimeDiagnosticIntent(
  rawText: string,
  now: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): HostTimeDiagnosticIntent {
  const text = rawText.trim();
  const bare = /^(\d{4})$/.exec(text);
  const explicit = /^\/diag(?:\s+(.+))?$/i.exec(text);
  if (!bare && !explicit) return { kind: 'none' };
  if (explicit && !explicit[1]) return { kind: 'invalid', reply: diagnosticUsage() };

  const current = zonedParts(now, timeZone);
  let date = current.date;
  let digits = bare?.[1];
  if (explicit) {
    const args = explicit[1]!.trim().split(/\s+/);
    if (args.length === 1) digits = args[0];
    else if (args.length === 2 && /^(?:yesterday|昨天)$/i.test(args[0]!)) {
      date = previousDate(current.date);
      digits = args[1];
    } else if (args.length === 2 && validDate(args[0]!)) {
      date = args[0]!;
      digits = args[1];
    } else return { kind: 'invalid', reply: diagnosticUsage() };
  }

  const time = parseTime(digits);
  if (!time) {
    return { kind: 'invalid', reply: `无法识别诊断时间“${digits ?? ''}”。时间必须是 0000–2359。\n${diagnosticUsage()}` };
  }
  if (bare && date === current.date && time > current.time) {
    return {
      kind: 'future',
      reply: `今天 ${time} 尚未到达。若要查询昨天，请发送 /diag yesterday ${digits}。`,
    };
  }
  const target = `${date} ${time} (${timeZone})`;
  return { kind: 'diagnose', date, time, target, prompt: diagnosticPrompt(target) };
}

function diagnosticPrompt(target: string): string {
  return `<host_time_diagnostic>
用户通过管理员私聊的时间快捷入口，请诊断 ${target} 附近的 Link Bot 对话或任务。

执行要求：
1. 这是只读诊断任务。只定位问题并给出恢复方式和长期解决方案；不要修改代码、重试任务、提交、推送、部署或执行其他外部写操作。
2. 优先读取当前 Link Bot 项目的本地事件日志、错误日志和任务 SQLite 状态。
3. 先查询目标分钟，再按需扩大到前后 5 分钟。关联 messageId、chatId/topicId、taskId、turnId，区分“通知时间”和“真正失败时间”。
4. 本地证据不足时，可以使用 lark-cli 补充读取对应群聊或话题上下文。
5. 如果同一分钟存在多个合理候选，不要猜测；列出候选的群/话题/时间/任务类型，请用户选择。
6. 对 token、Cookie、授权码、密钥等敏感内容脱敏。明确区分直接证据、推断和结论置信度。
7. 最终用中文回答，至少包含：匹配对象、当前状态、直接错误、根因、是否卡住、如何恢复、长期修复建议。
</host_time_diagnostic>`;
}

function diagnosticUsage(): string {
  return '用法：发送四位时间（如 1626），或 /diag 1626、/diag yesterday 2359、/diag 2026-09-01 1626。';
}

function parseTime(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}$/.test(value)) return undefined;
  const hour = Number(value.slice(0, 2));
  const minute = Number(value.slice(2));
  return hour <= 23 && minute <= 59 ? `${value.slice(0, 2)}:${value.slice(2)}` : undefined;
}

function zonedParts(now: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
