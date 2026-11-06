import { freemem, totalmem } from 'node:os';
import type { HostResourceSampler, HostResourceSample } from './ResourceController.js';

export class SystemHostResourceSampler implements HostResourceSampler {
  async sample(): Promise<HostResourceSample> {
    const totalBytes = totalmem();
    return {
      totalBytes,
      usedBytes: totalBytes - freemem(),
      managerAndInfrastructureBytes: process.memoryUsage().rss,
      activeTurnPeakReserveBytes: 0,
      readySlotReserveBytes: 0,
    };
  }
}
