import { createConnection, createServer, type Server } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FeishuIncomingMessage, FeishuOutgoingReply } from '../feishu/FeishuGateway.js';

export interface HostControlMessageHandler {
  handleMessage(message: FeishuIncomingMessage): Promise<{ reply: string; renderedReply?: FeishuOutgoingReply['rendered']; delivery?: FeishuOutgoingReply['delivery'] }>;
}

export class HostControlClient {
  constructor(private readonly socketPath: string) {}

  handleMessage(message: FeishuIncomingMessage): Promise<{ reply: string; renderedReply?: FeishuOutgoingReply['rendered']; delivery?: FeishuOutgoingReply['delivery'] }> {
    return new Promise((resolveRequest, reject) => {
      const socket = createConnection(this.socketPath);
      let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ message })}\n`));
      socket.on('data', (chunk) => { response += chunk; });
      socket.on('error', reject);
      socket.on('end', () => {
        try {
          const parsed = JSON.parse(response) as { ok: boolean; result?: Awaited<ReturnType<HostControlMessageHandler['handleMessage']>>; error?: string };
          if (!parsed.ok || !parsed.result) reject(new Error(parsed.error ?? 'Host control request failed.'));
          else resolveRequest(parsed.result);
        } catch (error) { reject(error); }
      });
    });
  }
}

export async function startHostControlServer(socketPath: string, handler: HostControlMessageHandler): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true });
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    let request = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      request += chunk;
      if (!request.includes('\n')) return;
      try {
        const parsed = JSON.parse(request.trim()) as { message: FeishuIncomingMessage };
        const result = await handler.handleMessage(parsed.message);
        socket.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolveListen(); });
  });
  await chmod(socketPath, 0o600);
  return server;
}
