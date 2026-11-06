export type JsonRpcId = string | number;
// Reference releases for fixed container images. Host compatibility is checked
// against the actual App Server schema, not this version list.
export const SUPPORTED_CODEX_CLI_VERSION = '0.161.0';
export const SUPPORTED_CODEX_CLI_VERSIONS = ['0.145.0', '0.146.0', '0.147.0', '0.153.4', '0.156.1', '0.161.0'] as const;

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest extends AppServerNotification {
  id: JsonRpcId;
}

export interface AppServerResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: unknown;
}

export function parseJsonRpcMessage(value: unknown):
  | { kind: 'notification'; message: AppServerNotification }
  | { kind: 'request'; message: AppServerRequest }
  | { kind: 'response'; message: AppServerResponse } {
  if (!isRecord(value)) {
    throw new Error('App-server message must be an object.');
  }
  const hasId = typeof value.id === 'string' || typeof value.id === 'number';
  if (typeof value.method === 'string') {
    const message = { method: value.method, params: value.params };
    return hasId
      ? { kind: 'request', message: { ...message, id: value.id as JsonRpcId } }
      : { kind: 'notification', message };
  }
  if (hasId && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'))) {
    return {
      kind: 'response',
      message: {
        id: value.id as JsonRpcId,
        ...(Object.hasOwn(value, 'result') ? { result: value.result } : {}),
        ...(Object.hasOwn(value, 'error') ? { error: value.error } : {}),
      },
    };
  }
  throw new Error('App-server message is not a JSON-RPC request, response, or notification.');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid app-server ${context}.`);
  }
  return value;
}

export function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid app-server ${context}.`);
  }
  return value;
}
