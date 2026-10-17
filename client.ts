/** Shared renderer adapter. No Electron or Node access is exposed to the editor. */
import type { BoundingModelsStatus } from './model-contract';

type ModuleBridge = {
  streaming?: number;
  capabilities?(): Promise<{ available: boolean }>;
  list?(): Promise<Array<{ id: string; enabled?: boolean; operations: string[] }>>;
  onChanged?(listener: () => void): () => void;
  ensure(request: { module: string; operation: string }): Promise<{ available: boolean }>;
  run(request: { module: string; operation: string; input: unknown; jobId: string }): Promise<any>;
  cancel(jobId: string): Promise<boolean>;
  message(request: { jobId: string; data: unknown }): Promise<boolean>;
  onMessage(listener: (event: { jobId: string; data: any }) => void): () => void;
};
export const desktopPackingBridge = (): ModuleBridge | null => {
  const bridge = (globalThis as typeof globalThis & { animatusDesktop?: { modules?: ModuleBridge } }).animatusDesktop?.modules;
  return bridge?.streaming === 1 ? bridge : null;
};

/** Passive inspection: opening the editor must never start an installation. */
export async function installedDesktopPacking(version: 'v2' | 'v3' = 'v3'): Promise<boolean> {
  const bridge = desktopPackingBridge();
  if (!bridge?.list) return false;
  try {
    if (bridge.capabilities && !(await bridge.capabilities()).available) return false;
    const modules = await bridge.list();
    return modules.some(module => module.id === 'dxf-packing' && module.enabled !== false
      && Array.isArray(module.operations) && module.operations.includes(`pack-${version}`));
  } catch { return false; }
}

export function observeDesktopPacking(listener: (available: boolean) => void): () => void {
  let disposed = false, revision = 0;
  const update = async () => {
    const current = ++revision;
    const available = await installedDesktopPacking();
    if (!disposed && current === revision) listener(available);
  };
  void update();
  let unsubscribe: (() => void) | undefined;
  try { unsubscribe = desktopPackingBridge()?.onChanged?.(() => { void update(); }); }
  catch { /* Older or restricted hosts may not expose change notifications. */ }
  return () => { disposed = true; unsubscribe?.(); };
}
const abortError = () => { const error = new Error('Berechnung abgebrochen.'); error.name = 'AbortError'; return error; };

export async function getBoundingModelsStatus(signal?: AbortSignal): Promise<BoundingModelsStatus> {
  const bridge = desktopPackingBridge();
  if (!bridge) return { ready: false, reason: 'desktop-required', models: [] };
  const jobId = globalThis.crypto?.randomUUID?.() || `models-${Date.now()}-${Math.random()}`;
  const cancel = () => { void bridge.cancel(jobId).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) return { ready: false, reason: 'missing-models', models: [] };
    // Inspection must not prompt an installation just because settings opened.
    const result = await bridge.run({ module: 'dxf-packing', operation: 'models-status-v2', input: {},
      jobId });
    if (!result || typeof result.ready !== 'boolean' || !Array.isArray(result.models)
      || result.models.length !== 2 || !['nester', 'rl4co'].every(id => result.models.some((model: any) => model.id === id))
      || result.models.some((model: any) => typeof model.ready !== 'boolean')
      || result.models.some((model: any) => model.ready && (!Number.isInteger(model.maxPieces) || model.maxPieces < 1 || model.maxPieces > 2000))
      || (result.ready && result.models.some((model: any) => !model.ready))) {
      return { ready: false, reason: 'module-update', models: [] };
    }
    return result;
  } catch {
    return { ready: false, reason: 'module-update', models: [] };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

/** null means unavailable before execution; runtime failures must never replay work. */
export async function runDesktopPacking(operation: string, input: unknown, options: {
  signal?: AbortSignal;
  onStarted?: () => void;
  onEvent?: (data: any, reply: (data: unknown) => Promise<boolean>) => void | Promise<void>;
} = {}): Promise<{ result: any } | null> {
  const bridge = desktopPackingBridge();
  if (!bridge) return null;
  if (options.signal?.aborted) throw abortError();
  let available = false;
  try { available = (await bridge.ensure({ module: 'dxf-packing', operation })).available; }
  catch { /* Missing catalogs/older hosts keep the browser computation. */ }
  if (options.signal?.aborted) throw abortError();
  if (!available) return null;
  const jobId = globalThis.crypto?.randomUUID?.() || `dxf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let callbackError: unknown;
  const cancel = () => { void bridge.cancel(jobId).catch(() => {}); };
  const unsubscribe = bridge.onMessage(event => {
    if (event.jobId !== jobId || options.signal?.aborted) return;
    void Promise.resolve().then(() => options.onEvent?.(event.data,
      data => bridge.message({ jobId, data }))).catch(error => { callbackError = error; cancel(); });
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    options.onStarted?.();
    const result = await bridge.run({ module: 'dxf-packing', operation, input, jobId });
    if (options.signal?.aborted) throw abortError();
    if (callbackError) throw callbackError;
    if (result?.type === 'stopped') throw abortError();
    return { result };
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (callbackError) throw callbackError;
    throw error;
  } finally {
    unsubscribe();
    options.signal?.removeEventListener('abort', cancel);
  }
}

/** The subset of the Web Worker protocol used by both DXF editors. */
export function createDesktopPackingWorker(version: 'v2' | 'v3', browserWorker: () => Worker): Worker {
  if (!desktopPackingBridge()) return browserWorker();
  const events = new EventTarget();
  let cachedBlocks: unknown;
  let fallback: Worker | undefined;
  let controller: AbortController | undefined;
  let terminated = false;
  const emit = (data: any) => {
    if (terminated) return;
    const event = new MessageEvent('message', { data });
    events.dispatchEvent(event);
    facade.onmessage?.call(facade, event);
  };
  const facade = {
    onmessage: null,
    onerror: null,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    terminate() {
      terminated = true;
      controller?.abort();
      fallback?.terminate();
    },
    postMessage(message: any) {
      if (terminated) return;
      if (fallback && message.type !== 'pack') {
        if (message.type === 'initBlocks') cachedBlocks = message.blocks;
        fallback.postMessage(message);
        return;
      }
      if (message.type === 'initBlocks') {
        cachedBlocks = message.blocks;
        queueMicrotask(() => emit({ type: 'init-ok' }));
      } else if (message.type === 'stop') {
        controller?.abort();
      } else if (message.type === 'pack') {
        if (controller || fallback) { emit({ type: 'error', message: 'Es läuft bereits eine Berechnung.' }); return; }
        const active = new AbortController();
        controller = active;
        const input = { ...message.payload, useCache: false,
          blocks: message.payload.useCache ? cachedBlocks : message.payload.blocks };
        void (async () => {
          try {
            const operation = version === 'v2' && input.extreme && input.extreme.strategy !== 'hybrid' && input.blocks?.some((block: any) => block.rotationGroupAngles?.length > 0) ? 'pack-grouped-v2'
              : version === 'v2' && input.extreme?.timeBudgetMs > 300000 ? 'pack-configured-v2'
              : version === 'v2' && input.extreme?.strategy === 'hybrid' ? 'pack-hybrid-v2'
              : version === 'v2' && input.extreme && input.initialLayout ? 'pack-continue-v2'
              : version === 'v2' && input.extreme ? 'pack-nesting-v2'
              : version === 'v2' && input.targetLengthMm ? 'pack-target-v2'
              : `pack-${version}`;
            const local = await runDesktopPacking(operation, input, { signal: active.signal, onEvent: emit, onStarted: () => emit({type:'packing-execution',location:'desktop',backend:'preparing'}) });
            if (terminated) return;
            if (local) emit(local.result);
            else {
              if (input.extreme?.strategy === 'hybrid') {
                throw new Error('Die Modellkombination ist nicht verfügbar. Öffne die Bounding-Einstellungen und prüfe die Modelle oder wähle die adaptive Suche.');
              }
              fallback = browserWorker();
              emit({type:'packing-execution',location:'browser',backend:'preparing'});
              fallback.onmessage = event => {
                if (['done', 'error', 'stopped'].includes(event.data?.type)) {
                  const completed = fallback;
                  fallback = undefined;
                  completed?.terminate();
                }
                emit(event.data);
              };
              fallback.onerror = event => {
                fallback?.terminate();
                fallback = undefined;
                events.dispatchEvent(new Event('error'));
                facade.onerror?.call(facade, event);
              };
              // Send the full blocks even when the browser worker has no cache yet.
              fallback.postMessage({ type: 'pack', payload: input });
            }
          } catch (error) {
            emit(active.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? { type: 'stopped' } : {
              type: 'error', message: error instanceof Error ? error.message : 'Die Berechnung konnte nicht abgeschlossen werden. Versuche es noch einmal.'
            });
          } finally { if (controller === active) controller = undefined; }
        })();
      }
    }
  } as unknown as Worker;
  return facade;
}
