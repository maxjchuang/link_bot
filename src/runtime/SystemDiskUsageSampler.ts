import { statfs } from 'node:fs/promises';
import type { DiskUsageSampler } from './DiskLifecycleController.js';

export class SystemDiskUsageSampler implements DiskUsageSampler {
  async sample(path: string) {
    const stats = await statfs(path, { bigint: true });
    const totalBytes = safeNumber(stats.bsize * stats.blocks, 'totalBytes');
    const freeBytes = safeNumber(stats.bsize * stats.bfree, 'freeBytes');
    const availableBytes = safeNumber(stats.bsize * stats.bavail, 'availableBytes');
    const usedBytes = totalBytes - freeBytes;
    return {
      path,
      totalBytes,
      usedBytes,
      availableBytes,
      usedRatio: totalBytes === 0 ? 0 : usedBytes / totalBytes,
    };
  }
}

function safeNumber(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Disk filesystem ${field} exceeds the supported range.`);
  }
  return Number(value);
}
