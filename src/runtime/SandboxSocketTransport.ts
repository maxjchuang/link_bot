import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection } from 'node:net';
import { Duplex } from 'node:stream';

const BRIDGE_ROOT = '/run/link-bot/bridge';
const READY = 'LINK_BOT_BRIDGE_CONNECTED';
export type SandboxSocketConnector = (endpoint: string) => Duplex;
export type SandboxTransportMode = 'auto' | 'unix-socket' | 'docker-exec';

export function resolveSandboxTransport(mode: SandboxTransportMode = 'auto', platform = process.platform): Exclude<SandboxTransportMode, 'auto'> {
  return mode === 'auto' ? platform === 'darwin' ? 'docker-exec' : 'unix-socket' : mode;
}

export function dockerSandboxEndpoint(containerName: string, socketPath: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName)) throw new Error('Invalid sandbox container name.');
  if (!/^\/run\/link-bot\/bridge\/(?:supervisor\.sock|tasks\/[A-Za-z0-9_.-]+\.sock)$/.test(socketPath)
    || socketPath.includes('..')) throw new Error('Invalid sandbox bridge socket.');
  return `docker-exec://${containerName}${socketPath}`;
}

export function parseDockerSandboxEndpoint(endpoint: string): { containerName: string; socketPath: string } | undefined {
  if (!endpoint.startsWith('docker-exec:')) return undefined;
  const match = /^docker-exec:\/\/([^/]+)(\/[^?#]*)$/.exec(endpoint);
  if (!match || dockerSandboxEndpoint(match[1]!, match[2]!) !== endpoint) throw new Error('Invalid sandbox transport endpoint.');
  return { containerName: match[1]!, socketPath: match[2]! };
}

/** Docker exec relays a socket inside the existing user container; it never creates a task container or exposes a TCP port. */
export function createSandboxConnection(endpoint: string, options: {
  spawnProcess?: (command: string, args: string[]) => ChildProcessWithoutNullStreams;
} = {}): Duplex {
  const target = parseDockerSandboxEndpoint(endpoint);
  if (!target) return createConnection(endpoint);
  const start = options.spawnProcess ?? ((command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] }));
  const child = start('docker', ['exec', '-i', '--user', '0:0', target.containerName,
    'node', '/usr/local/bin/link-bot-sandbox-bridge.mjs', target.socketPath]);
  return new DockerExecSocket(child);
}

class DockerExecSocket extends Duplex {
  private connected = false;
  private diagnostics = '';
  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    super({ allowHalfOpen: false });
    child.stdout.on('data', chunk => { if (!this.push(chunk)) child.stdout.pause(); });
    child.stdout.once('end', () => this.push(null));
    child.stdin.on('error', error => this.destroy(error));
    child.stdout.on('error', error => this.destroy(error));
    child.stderr.on('data', chunk => {
      // The helper emits fixed status markers only. Never forward arbitrary stderr or request/response contents.
      this.diagnostics = (this.diagnostics + chunk.toString()).slice(-2048);
      const failure = /LINK_BOT_BRIDGE_ERROR:(ENOENT|ECONNREFUSED|EPIPE|EACCES|ENOTSOCK|ETIMEDOUT)/.exec(this.diagnostics);
      if (failure) { this.destroy(Object.assign(new Error(`User sandbox bridge unavailable (${failure[1]}).`), { code: failure[1] })); return; }
      if (!this.connected && this.diagnostics.includes(READY)) { this.connected = true; this.emit('connect'); }
    });
    child.once('error', error => this.destroy(error));
    child.once('close', code => {
      if (this.destroyed) return;
      if (!this.connected || code !== 0) this.destroy(new Error(`User sandbox Docker bridge exited (${code ?? 'signal'}).`));
      else this.push(null);
    });
  }
  override _read(): void { this.child.stdout.resume(); }
  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.child.stdin.write(chunk, encoding, callback);
  }
  override _final(callback: (error?: Error | null) => void): void { this.child.stdin.end(callback); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
    if (!this.child.killed) this.child.kill('SIGTERM');
    callback(error);
  }
}

export function sandboxControlSocketPath(): string { return `${BRIDGE_ROOT}/supervisor.sock`; }
