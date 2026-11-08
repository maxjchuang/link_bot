import type { DockerCommandRunner } from './DockerRuntime.js';
import type { HostResourceSample, HostResourceSampler } from './ResourceController.js';

/** On macOS the Docker VM, not macOS free RAM, is the sandbox capacity boundary. */
export class DockerDaemonResourceSampler implements HostResourceSampler {
  constructor(private readonly runner: DockerCommandRunner) {}
  async sample(): Promise<HostResourceSample> {
    const [info, stats] = await Promise.all([
      this.runner.run(['info', '--format', '{{.MemTotal}}'], { timeoutMs: 10_000 }),
      this.runner.run(['stats', '--no-stream', '--format', '{{.MemUsage}}'], { timeoutMs: 10_000 }),
    ]);
    const totalBytes = Number(info.stdout.trim());
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) throw new Error('Docker returned an invalid memory budget.');
    const workingBytes = stats.stdout.split(/\r?\n/).filter(line => line.trim()).reduce((sum, line) => sum + dockerMemoryBytes(line.split('/')[0]!.trim()), 0);
    const infrastructure = Math.min(512 * 1024 * 1024, Math.floor(totalBytes / 4));
    return { totalBytes, usedBytes: Math.min(totalBytes, workingBytes + infrastructure),
      managerAndInfrastructureBytes: infrastructure, activeTurnPeakReserveBytes: 0, readySlotReserveBytes: 0 };
  }
}

function dockerMemoryBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|kB|MB|GB|TB)$/i.exec(value);
  if (!match) throw new Error('Docker returned an invalid container memory sample.');
  const unit = match[2]!.toLowerCase();
  const powers: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
    kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4 };
  const bytes = Math.ceil(Number(match[1]) * powers[unit]!);
  if (!Number.isSafeInteger(bytes)) throw new Error('Docker memory sample exceeds the supported range.');
  return bytes;
}
