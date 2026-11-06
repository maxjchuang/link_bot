import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { AppServerConnection, AppServerResponseError } from '../../src/appserver/AppServerConnection.js';

describe('AppServerConnection', () => {
  it('reconnects to an initialized process and can resume its thread', async () => {
    const peer = createPeer();
    const connection = peer.connection();
    const initialized = connection.initialize('0.1.0', { experimentalApi: true });
    await peer.nextClientMessage();
    peer.send([{ id: 1, error: { code: -32600, message: 'Already initialized' } }]);
    await expect(initialized).resolves.toBeUndefined();

    const resumed = connection.request('thread/resume', { threadId: 'thread_1' });
    await expect(peer.nextClientMessage()).resolves.toMatchObject({ id: 2, method: 'thread/resume' });
    peer.send([{ id: 2, result: { thread: { id: 'thread_1' } } }]);
    await expect(resumed).resolves.toEqual({ thread: { id: 'thread_1' } });
  });

  it.each([
    { code: -32600, message: 'Invalid request' },
    { code: -32000, message: 'Already initialized' },
  ])('preserves other initialization failures: %j', async (error) => {
    const peer = createPeer();
    const initialized = peer.connection().initialize('0.1.0');
    await peer.nextClientMessage();
    peer.send([{ id: 1, error }]);
    await expect(initialized).rejects.toMatchObject({ responseError: error });
  });

  it('initializes, correlates fragmented responses, and preserves notification order', async () => {
    const peer = createPeer();
    const connection = peer.connection();
    const initialized = connection.initialize('0.1.0');
    const initializeRequest = await peer.nextClientMessage();
    expect(initializeRequest).toMatchObject({ id: 1, method: 'initialize' });
    peer.sendRaw('{"id":1,"res');
    peer.sendRaw('ult":{"serverVersion":"0.145.0"}}\n');
    await expect(initialized).resolves.toEqual({ serverVersion: '0.145.0' });
    await expect(peer.nextClientMessage()).resolves.toEqual({ method: 'initialized', params: {} });

    const notifications = connection.notifications()[Symbol.asyncIterator]();
    peer.send([
      { method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
      { method: 'item/agentMessage/delta', params: { delta: 'hello' } },
    ]);
    await expect(notifications.next()).resolves.toEqual({
      done: false,
      value: { method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } },
    });
    await expect(notifications.next()).resolves.toEqual({
      done: false,
      value: { method: 'item/agentMessage/delta', params: { delta: 'hello' } },
    });
  });

  it('surfaces server requests and writes result and error responses', async () => {
    const peer = createPeer();
    const connection = peer.connection({ generation: 4 });
    const requests = connection.serverRequests()[Symbol.asyncIterator]();
    peer.send([{ id: 'approval_1', method: 'item/commandExecution/requestApproval', params: { command: 'npm test' } }]);

    await expect(requests.next()).resolves.toEqual({
      done: false,
      value: {
        id: 'approval_1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'npm test' },
      },
    });
    await connection.respond('approval_1', { decision: 'accept' });
    await expect(peer.nextClientMessage()).resolves.toEqual({ id: 'approval_1', result: { decision: 'accept' } });
    await connection.respondError(7, -32602, 'invalid decision', { field: 'decision' });
    await expect(peer.nextClientMessage()).resolves.toEqual({
      id: 7,
      error: { code: -32602, message: 'invalid decision', data: { field: 'decision' } },
    });
    expect(connection.generation).toBe(4);
  });

  it('rejects protocol error responses with method context', async () => {
    const peer = createPeer();
    const connection = peer.connection();
    const pending = connection.request('thread/read', { threadId: 'missing' });
    await peer.nextClientMessage();
    peer.send([{ id: 1, error: { code: -32000, message: 'not found' } }]);

    await expect(pending).rejects.toMatchObject({
      name: 'AppServerResponseError',
      method: 'thread/read',
      message: 'App-server request failed: thread/read (code=-32000, message=not found)',
      responseError: { code: -32000, message: 'not found' },
    });
  });

  it('times out one request without disconnecting the connection', async () => {
    vi.useFakeTimers();
    try {
      const peer = createPeer();
      const connection = peer.connection({ requestTimeoutMs: 100 });
      const timedOut = connection.request('thread/read', { threadId: 'slow' });
      const timedOutAssertion = expect(timedOut).rejects.toThrow('App-server request timed out: thread/read');
      await vi.advanceTimersByTimeAsync(100);
      await timedOutAssertion;

      const next = connection.request('thread/read', { threadId: 'fast' });
      peer.send([{ id: 2, result: { thread: { id: 'fast' } } }]);
      await expect(next).resolves.toEqual({ thread: { id: 'fast' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['malformed JSON', '{bad-json}\n', 'JSON'],
    ['invalid message', '{"unexpected":true}\n', 'not a JSON-RPC'],
  ])('disconnects on %s and rejects pending requests', async (_name, frame, message) => {
    const peer = createPeer();
    const connection = peer.connection();
    const pending = connection.request('thread/read', { threadId: 'thread_1' });
    peer.sendRaw(frame);

    await expect(pending).rejects.toThrow(message);
    expect(() => connection.request('thread/read', { threadId: 'thread_2' })).toThrow(message);
  });

  it('disconnects when an unterminated frame exceeds the byte limit', async () => {
    const peer = createPeer();
    const connection = peer.connection({ maxBufferedBytes: 8 });
    const pending = connection.request('thread/read', {});
    peer.sendRaw('123456789');

    await expect(pending).rejects.toThrow(
      'bufferedBytes=9, maxBufferedBytes=8, pendingMethods=thread/read',
    );
  });

  it('accepts a thread/resume response larger than the former 1 MiB default', async () => {
    const peer = createPeer();
    const connection = peer.connection();
    const pending = connection.request('thread/resume', { threadId: 'thread_large' });
    await peer.nextClientMessage();
    const history = 'x'.repeat(1_100_000);
    peer.send([{ id: 1, result: { thread: { id: 'thread_large', history } } }]);

    await expect(pending).resolves.toEqual({ thread: { id: 'thread_large', history } });
  });

  it('accepts multiple complete frames in one chunk when each frame is within the byte limit', async () => {
    const peer = createPeer();
    const connection = peer.connection({ maxBufferedBytes: 40 });
    const notifications = connection.notifications()[Symbol.asyncIterator]();
    peer.sendRaw('{"method":"first","params":{}}\n{"method":"second","params":{}}\n');

    await expect(notifications.next()).resolves.toMatchObject({ value: { method: 'first' } });
    await expect(notifications.next()).resolves.toMatchObject({ value: { method: 'second' } });
  });

  it('disconnects when a consumer does not drain its bounded queue', async () => {
    const peer = createPeer();
    const connection = peer.connection({ maxQueuedMessages: 1 });
    const pending = connection.request('thread/read', {});
    peer.send([
      { method: 'first', params: {} },
      { method: 'second', params: {} },
    ]);

    await expect(pending).rejects.toThrow('event queue exceeded');
    const notifications = connection.notifications()[Symbol.asyncIterator]();
    await expect(notifications.next()).resolves.toEqual({ done: false, value: { method: 'first', params: {} } });
    await expect(notifications.next()).rejects.toThrow('event queue exceeded');
  });

  it('rejects every pending request when the readable side ends', async () => {
    const peer = createPeer();
    const connection = peer.connection();
    const first = connection.request('thread/read', { threadId: 'one' });
    const second = connection.request('thread/read', { threadId: 'two' });
    peer.serverToClient.end();

    await expect(first).rejects.toThrow('connection ended');
    await expect(second).rejects.toThrow('connection ended');
  });
});

function createPeer() {
  const serverToClient = new PassThrough();
  const clientToServer = new PassThrough();
  const clientMessages: unknown[] = [];
  const messageWaiters: Array<(message: unknown) => void> = [];
  let input = '';
  clientToServer.setEncoding('utf8');
  clientToServer.on('data', (chunk: string) => {
    input += chunk;
    for (;;) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as unknown;
      const waiter = messageWaiters.shift();
      if (waiter) waiter(message);
      else clientMessages.push(message);
    }
  });
  return {
    serverToClient,
    connection: (options: Partial<ConstructorParameters<typeof AppServerConnection>[0]> = {}) => new AppServerConnection({
      readable: serverToClient,
      writable: clientToServer,
      generation: 1,
      ...options,
    }),
    send: (messages: unknown[]) => serverToClient.write(messages.map((message) => JSON.stringify(message)).join('\n') + '\n'),
    sendRaw: (frame: string) => serverToClient.write(frame),
    nextClientMessage: async () => {
      const message = clientMessages.shift();
      if (message !== undefined) return message;
      return new Promise<unknown>((resolve) => messageWaiters.push(resolve));
    },
  };
}
