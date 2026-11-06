import { AppServerTurnDetailSink } from './AppServerTurnDetailSink.js';
import { SqliteTurnDetailStore } from './SqliteTurnDetailStore.js';
import { DetailResourceStore } from './DetailResourceStore.js';
import { AsyncTurnDetailRecorder } from './AsyncTurnDetailRecorder.js';
import { DetailViewStore } from './DetailViewStore.js';
import { TurnResultStore } from './TurnResultStore.js';
import { TurnDetailMaintenance } from './TurnDetailMaintenance.js';
import { TurnDetailTelemetry } from './TurnDetailTelemetry.js';
import { TurnDetailAccessAudit } from './TurnDetailAccessAudit.js';

export function createTurnDetailRuntime(statePath: string, clock: () => Date = () => new Date()): {
  sink: AppServerTurnDetailSink; store?: SqliteTurnDetailStore; resources?: DetailResourceStore; views?: DetailViewStore;
  results?: TurnResultStore; maintenance?: TurnDetailMaintenance; telemetry?: TurnDetailTelemetry; audit?: TurnDetailAccessAudit; maintain(): void; flush(): Promise<void>; close(): Promise<void>;
} {
  let store: SqliteTurnDetailStore | undefined;
  let views: DetailViewStore | undefined;
  let results: TurnResultStore | undefined;
  let maintenance: TurnDetailMaintenance | undefined;
  let telemetry: TurnDetailTelemetry | undefined;
  let audit: TurnDetailAccessAudit | undefined;
  try {
    store = new SqliteTurnDetailStore(statePath);
    const resources = new DetailResourceStore(`${statePath}.turn-details`, {
      allocated: (id, ownerKey) => store!.registerResource(id, ownerKey), removed: (id) => store!.forgetResource(id),
    });
    views = new DetailViewStore(statePath, clock);
    results = new TurnResultStore(statePath);
    maintenance = new TurnDetailMaintenance(statePath, resources, clock);
    try { telemetry = new TurnDetailTelemetry(statePath); } catch { /* Metrics are never a recording prerequisite. */ }
    try { audit = new TurnDetailAccessAudit(statePath, clock); } catch { /* Reads fail closed; execution/recording can continue. */ }
    const recorder = new AsyncTurnDetailRecorder(statePath, store, undefined, undefined, telemetry);
    return { store, resources, views, results, maintenance, telemetry, audit,
      sink: new AppServerTurnDetailSink(store, recorder, clock, telemetry, results),
      flush: () => recorder.flush(),
      maintain: () => {
        // Shared writer ownership fences maintenance in every process, not just this runtime.
        const start = performance.now(); const report = maintenance!.run();
        telemetry?.observe('cleanup', report.failed ? 'unavailable' : 'ok', performance.now() - start);
        telemetry?.flush(); telemetry?.gauges();
      },
      close: async () => { await recorder.close(); audit?.close(); telemetry?.close(); maintenance!.close(); results!.close(); views!.close(); store!.close(); } };
  } catch {
    store?.close();
    views?.close();
    results?.close();
    maintenance?.close();
    telemetry?.close();
    audit?.close();
    // Keep persistence fail-closed even when recording could not initialize.
    return { sink: new AppServerTurnDetailSink(undefined, undefined, clock), maintain: () => undefined,
      flush: async () => undefined, close: async () => undefined };
  }
}
