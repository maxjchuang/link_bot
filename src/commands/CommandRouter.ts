export type CommandName =
  | 'help'
  | 'projects'
  | 'use'
  | 'new'
  | 'resume'
  | 'send'
  | 'status'
  | 'current'
  | 'model'
  | 'adduser'
  | 'upgrade'
  | 'restart'
  | 'tail'
  | 'rawtail'
  | 'stop'
  | 'sessions'
  | 'approve'
  | 'reject'
  | 'hook-status'
  | 'install-hooks'
  | 'uninstall-hooks';

export type IncomingText =
  | { kind: 'message'; text: string }
  | { kind: 'command'; name: string; args: string[]; raw: string };

const payloadCommands = new Set(['send']);

export function parseIncomingText(text: string): IncomingText {
  const trimmed = stripLeadingMentions(text.trim());
  if (!trimmed.startsWith('/')) {
    return { kind: 'message', text: trimmed };
  }

  const firstWhitespace = trimmed.search(/\s/);
  const hasWhitespace = firstWhitespace !== -1;
  const name = (hasWhitespace ? trimmed.slice(1, firstWhitespace) : trimmed.slice(1)).toLowerCase();
  const rest = hasWhitespace ? trimmed.slice(firstWhitespace + 1).trim() : '';
  const args = payloadCommands.has(name) ? (rest ? [rest] : []) : rest.split(/\s+/).filter(Boolean);

  return { kind: 'command', name, args, raw: trimmed };
}

function stripLeadingMentions(text: string): string {
  return text.replace(/^(?:@\S+\s+)*/, '');
}
