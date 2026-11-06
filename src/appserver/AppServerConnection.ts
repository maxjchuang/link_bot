import type { Readable, Writable } from 'node:stream';
import {
  parseJsonRpcMessage,
  type AppServerNotification,
  type AppServerRequest,
  type JsonRpcId,
} from './AppServerProtocol.js';

export interface AppServerConnectionOptions {
  readable: Readable;
  writable: Writable;
  generation: number;
  requestTimeoutMs?: number;
  maxBufferedBytes?: number;
  maxQueuedMessages?: number;
  disconnectReason?: () => Error | string | undefined;
}

export class AppServerConnection {
  readonly generation: number;
  private readonly requestTimeoutMs: number;
  private readonly maxBufferedBytes: number;
  private readonly notificationsQueue: AsyncBoundedQueue<AppServerNotification>;
  private readonly requestsQueue: AsyncBoundedQueue<AppServerRequest>;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private disconnected?: Error;

  constructor(private readonly options: AppServerConnectionOptions) {
    this.generation = options.generation;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxBufferedBytes = options.maxBufferedBytes ?? 16_777_216;
    const maxQueued = options.maxQueuedMessages ?? 1_000;
    this.notificationsQueue = new AsyncBoundedQueue(maxQueued, (error) => this.fail(error));
    this.requestsQueue = new AsyncBoundedQueue(maxQueued, (error) => this.fail(error));
    options.readable.setEncoding('utf8');
    options.readable.on('data', this.handleData);
    options.readable.once('error', this.handleError);
    options.readable.once('end', this.handleEnd);
    options.writable.once('error', this.handleError);
  }

  async initialize(clientVersion: string, capabilities: Record<string, unknown> | null = null): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.request('initialize', {
        clientInfo: { name: 'link-bot', version: clientVersion },
        capabilities,
      });
    } catch (error) {
      // A manager restart can reconnect to an already initialized process.
      if (error instanceof AppServerResponseError && error.method === 'initialize'
        && error.responseError && typeof error.responseError === 'object'
        && 'code' in error.responseError && error.responseError.code === -32600
        && 'message' in error.responseError && error.responseError.message === 'Already initialized') {
        return undefined;
      }
      throw error;
    }
    await this.notify('initialized', {});
    return result;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    this.assertConnected();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write({ id, method, params }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.assertConnected();
    return this.write({ method, params });
  }

  respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.assertConnected();
    return this.write({ id, result });
  }

  respondError(id: JsonRpcId, code: number, message: string, data?: unknown): Promise<void> {
    this.assertConnected();
    return this.write({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  notifications(): AsyncIterable<AppServerNotification> {
    return this.notificationsQueue;
  }

  serverRequests(): AsyncIterable<AppServerRequest> {
    return this.requestsQueue;
  }

  async close(): Promise<void> {
    if (!this.disconnected) {
      await new Promise<void>((resolve, reject) => {
        this.options.writable.end((error?: Error | null) => error ? reject(error) : resolve());
      }).catch((error) => this.fail(asError(error)));
    }
    this.detach();
    this.fail(this.disconnected ?? new Error('App-server connection closed.'));
  }

  private readonly handleData = (chunk: string): void => {
    if (this.disconnected) return;
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') > this.maxBufferedBytes) {
          this.fail(this.frameLimitError(Buffer.byteLength(this.buffer, 'utf8')));
        }
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (lineBytes > this.maxBufferedBytes) {
        this.fail(this.frameLimitError(lineBytes));
        return;
      }
      try {
        this.dispatch(parseJsonRpcMessage(JSON.parse(line)));
      } catch (error) {
        this.fail(asError(error));
        return;
      }
    }
  };

  private frameLimitError(bufferedBytes: number): Error {
    const pendingMethods = [...new Set([...this.pending.values()].map((request) => request.method))];
    return new Error(
      `App-server frame buffer exceeded its configured limit `
      + `(bufferedBytes=${bufferedBytes}, maxBufferedBytes=${this.maxBufferedBytes}, `
      + `pendingMethods=${pendingMethods.join(',') || 'none'}).`,
    );
  }

  private dispatch(message: ReturnType<typeof parseJsonRpcMessage>): void {
    if (message.kind === 'notification') {
      this.notificationsQueue.push(message.message);
      return;
    }
    if (message.kind === 'request') {
      this.requestsQueue.push(message.message);
      return;
    }
    const pending = this.pending.get(message.message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.message.id);
    clearTimeout(pending.timer);
    if (Object.hasOwn(message.message, 'error')) {
      pending.reject(new AppServerResponseError(pending.method, message.message.error));
    } else {
      pending.resolve(message.message.result);
    }
  }

  private readonly handleError = (error: Error): void => this.fail(error);
  private readonly handleEnd = (): void => {
    const reason = this.options.disconnectReason?.();
    this.fail(reason instanceof Error ? reason : new Error(reason ?? 'App-server connection ended.'));
  };

  private fail(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = error;
    this.detach();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.notificationsQueue.close(error);
    this.requestsQueue.close(error);
  }

  private detach(): void {
    this.options.readable.off('data', this.handleData);
    this.options.readable.off('error', this.handleError);
    this.options.readable.off('end', this.handleEnd);
    this.options.writable.off('error', this.handleError);
  }

  private assertConnected(): void {
    if (this.disconnected) {
      throw this.disconnected;
    }
  }

  private async write(message: unknown): Promise<void> {
    const frame = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.options.writable.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
}

export class AppServerResponseError extends Error {
  constructor(readonly method: string, readonly responseError: unknown) {
    super(`App-server request failed: ${method}${formatResponseError(responseError)}`);
    this.name = 'AppServerResponseError';
  }
}

function formatResponseError(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const code = typeof record.code === 'number' || typeof record.code === 'string' ? String(record.code) : undefined;
  const message = typeof record.message === 'string' ? record.message.replaceAll(/\s+/g, ' ').trim().slice(0, 500) : undefined;
  if (!code && !message) return '';
  return ` (${[code ? `code=${code}` : undefined, message ? `message=${message}` : undefined].filter(Boolean).join(', ')})`;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class AsyncBoundedQueue<T> implements AsyncIterable<T> {
  private readonly queued: T[] = [];
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (reason: unknown) => void }> = [];
  private closed?: Error | true;

  constructor(private readonly maxQueued: number, private readonly onOverflow: (error: Error) => void) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.queued.length >= this.maxQueued) {
      this.onOverflow(new Error('App-server event queue exceeded its configured limit.'));
      return;
    }
    this.queued.push(value);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = error ?? true;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.queued.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed instanceof Error) throw this.closed;
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
