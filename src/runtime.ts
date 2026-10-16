import { MAX_BOUNDING_TIME_MS } from '../../dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/bounding-settings';
import modelProviders from './model-providers.cjs';
import orderPolicy from './order-policy.cjs';
import { createNativeNestingBackend, waitForNestingExit } from './native-nesting';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Engines = {
  installPackingRuntime: (scope: any, backend: any, nestingBackend?: any, execution?: any) => void;
  progressivePackDrawableBlocksPoly: (...args: any[]) => Promise<any>;
  rustNativeRasterBackend: any;
  rustWasmRasterBackend: any;
  cancelRustRasterPacking: () => void;
  computeBlockOutlineArea?: (block: any) => number;
};

export function startModule(engine: Engines, baseURL: string) {
  const port = parentPort!;
  let cancelled = false;
  const modelAbort = new AbortController();
  let sequence = 0;
  const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
  const event = (value: unknown) => { if (!cancelled) port.postMessage({ type: 'event', value }); };
  port.on('message', async message => {
    if (message?.type === 'cancel') {
      cancelled = true;
      modelAbort.abort();
      engine.cancelRustRasterPacking();
      for (const task of pending.values()) task.reject(new Error('Abgebrochen'));
      pending.clear();
      // The host terminates this worker immediately after acknowledgement.
      // Reap owned children first so cancellation cannot orphan model processes.
      await Promise.all([modelProviders.waitForExit(), waitForNestingExit()]);
      port.postMessage({ type: 'cancelled' });
    } else if (message?.type === 'message') {
      const data = message.value;
      const task = pending.get(data?.orderRequestId);
      if (!task) return;
      pending.delete(data.orderRequestId);
      if (data.error) task.reject(new Error(String(data.error)));
      else task.resolve(String(data.unit));
    }
  });
  const nativeName = process.platform === 'win32' ? 'dxf-raster-packer.exe' : 'dxf-raster-packer';
  const rasterBackend = existsSync(fileURLToPath(new URL(nativeName, baseURL)))
    ? engine.rustNativeRasterBackend : engine.rustWasmRasterBackend;
  const { operation, input } = workerData;
  const nestingPath = fileURLToPath(new URL(process.platform === 'win32' ? 'animatus-nesting.exe' : 'animatus-nesting', baseURL));
  const nestingBackend = operation.endsWith('-v2') && existsSync(nestingPath)
    ? createNativeNestingBackend(nestingPath, modelAbort.signal) : undefined;
  void (async () => {
    const directory = path.dirname(fileURLToPath(baseURL));
    if (operation === 'models-status-v2') {
      const status = await modelProviders.inspectModels(directory, modelAbort.signal);
      await modelProviders.waitForExit();
      if (!cancelled) port.postMessage({ type: 'result', value: status });
      return;
    }
    validate(input);
    if (input.extreme?.strategy === 'hybrid' && !['pack-hybrid-v2', 'pack-configured-v2'].includes(operation)) throw new Error('Aktualisiere das DXF-Modul für die Modellkombination.');
    if (operation === 'pack-hybrid-v2' || (operation === 'pack-configured-v2' && input.extreme?.strategy === 'hybrid')) {
      if (!input.extreme || input.extreme.strategy !== 'hybrid') throw new Error('Modellkombination fehlt');
      const started = performance.now();
      event({ type: 'search-progress', stage: 'models', elapsedMs: 0, timeBudgetMs: input.extreme.timeBudgetMs, attempts: 0 });
      input.modelCandidates = await modelProviders.collectCandidates(directory, input, modelAbort.signal);
      input.extreme.preparationElapsedMs = performance.now() - started;
    }
    const orderModelPath = path.join(directory, 'order-policy.json');
    if (operation.endsWith('-v2') && input.extreme && input.extreme.strategy !== 'hybrid'
      && input.useRealBounding && engine.computeBlockOutlineArea && existsSync(orderModelPath)) {
      const started = performance.now();
      const model = orderPolicy.validateDeployment(JSON.parse(readFileSync(orderModelPath, 'utf8')));
      // A proposal changes only order. The packer still validates every resulting layout.
      if (input.rotationStep === 180 && input.fabricWidth === model.config.width && input.blocks.length <= model.maxPieces) {
        const features = orderPolicy.features(input.blocks.map((b: any) => ({ width: b.width, height: b.height, area: engine.computeBlockOutlineArea!(b) })), input.fabricWidth);
        input.modelCandidates = { orders: orderPolicy.candidates(model, features, 5, 42), layouts: [] };
        input.extreme.preparationElapsedMs = (input.extreme.preparationElapsedMs || 0) + performance.now() - started;
      }
    }
    if (operation === 'pack-extreme-v2' && !input.extreme) throw new Error('Suchdauer fehlt');
    if (operation === 'pack-nesting-v2' && (!input.extreme || !input.useRealBounding || input.extreme.strategy === 'hybrid')) throw new Error('Wähle Extreme Bounding, um die Konturen zu optimieren.');
    if (operation === 'pack-configured-v2' && (!input.extreme || !input.useRealBounding)) throw new Error('Wähle Extreme Bounding und eine Suchdauer.');
    if (operation === 'pack-continue-v2' && (!input.initialLayout || !input.extreme || !input.useRealBounding || input.extreme.strategy === 'hybrid')) throw new Error('Wähle eine vorhandene Anordnung zum Weiteroptimieren.');
    if (input.initialLayout && !['pack-continue-v2', 'pack-configured-v2'].includes(operation)) throw new Error('Aktualisiere das DXF-Modul zum Weiteroptimieren.');
    if (cancelled) return;
    if (operation.startsWith('pack-')) {
      const scope = { postMessage(message: any) {
        if (cancelled) return;
        if (message.type === 'done') port.postMessage({ type: 'result', value: message });
        else if (message.type === 'error') port.postMessage({ type: 'error', message: message.message });
        else event(message);
      }, onmessage: null as any };
      engine.installPackingRuntime(scope, rasterBackend, nestingBackend, {location:'desktop',rasterBackend:rasterBackend === engine.rustNativeRasterBackend ? 'rust-native' : 'rust-wasm'});
      await scope.onmessage({ data: { type: 'pack', payload: input } });
    } else if (operation.startsWith('poly-')) {
      let pruned = false;
      let backend: unknown;
      const packed = await engine.progressivePackDrawableBlocksPoly(input.blocks, input.fabricWidth, input.rotationStep, {
        ...input, shouldStop: () => cancelled, rasterBackend, nestingBackend,
        onBackend: (state: unknown) => { backend = state; },
        onPruned: (state: unknown) => { pruned = true; event({ type: 'pruned', state }); },
        resolveOrderUnit: (space: unknown) => new Promise<string>((resolve, reject) => {
          const orderRequestId = `order-${++sequence}`;
          pending.set(orderRequestId, { resolve, reject });
          event({ type: 'resolve-order-unit', orderRequestId, space });
        })
      });
      if (!cancelled) port.postMessage({ type: 'result', value: { packed, pruned, backend } });
    } else throw new Error('Unbekannte Berechnung');
  })().catch(async error => {
    engine.cancelRustRasterPacking();
    await Promise.all([modelProviders.waitForExit(), waitForNestingExit()]);
    if (!cancelled) port.postMessage({ type: 'error', message: error.message });
  });
}

function validate(input: any) {
  if (!input || !Array.isArray(input.blocks) || !input.blocks.length || input.blocks.length > 2000
    || !Number.isFinite(input.fabricWidth) || input.fabricWidth <= 0 || input.fabricWidth > 100000
    || (input.rotationStep !== null && input.rotationStep !== undefined
      && (!Number.isFinite(input.rotationStep) || input.rotationStep < 0 || input.rotationStep > 360))
    || (input.maxRandomOrders !== undefined && (!Number.isInteger(input.maxRandomOrders)
      || input.maxRandomOrders < 0 || input.maxRandomOrders > 10000))) throw new Error('Ungültiger Berechnungsauftrag');
  if (input.extreme && (!input.useRealBounding || !Number.isFinite(input.extreme.timeBudgetMs)
    || input.extreme.timeBudgetMs < 100 || input.extreme.timeBudgetMs > MAX_BOUNDING_TIME_MS
    || (input.extreme.maxAttempts !== undefined && (!Number.isInteger(input.extreme.maxAttempts)
      || input.extreme.maxAttempts < 1 || input.extreme.maxAttempts > 10000)))) {
    throw new Error('Ungültige Suchdauer');
  }
  if (input.targetLengthMm !== undefined && (!Number.isFinite(input.targetLengthMm) || input.targetLengthMm <= 0 || input.targetLengthMm > 1000000)) throw new Error('Ungültige Stofflänge');
  if (input.stopAtTarget !== undefined && typeof input.stopAtTarget !== 'boolean') throw new Error('Ungültiges Längenziel');
  if (input.extreme?.strategy !== undefined && !['hybrid', 'adaptive'].includes(input.extreme.strategy)) throw new Error('Ungültiger Suchmodus');
  if (input.extreme?.workers !== undefined && ![1, 2, 3].includes(input.extreme.workers)) throw new Error('Ungültige Anzahl paralleler Suchläufe');
  if (input.initialLayout && (typeof input.initialLayout.signature !== 'string' || input.initialLayout.signature.length > 100
    || !Array.isArray(input.initialLayout.placements) || input.initialLayout.placements.length !== input.blocks.length
    || input.initialLayout.placements.some((p: any) => !p || !Number.isInteger(p.blockIndex) || ![p.x, p.y, p.angle].every(Number.isFinite)))) throw new Error('Ungültige Startanordnung');
  let points = 0;
  for (const block of input.blocks) {
    if (!Array.isArray(block.packPaths) || !Array.isArray(block.paths)
      || !Number.isFinite(block.width) || !Number.isFinite(block.height)) throw new Error('Ungültige Kontur');
    for (const path of [...block.packPaths, ...block.paths]) {
      if (!Array.isArray(path.points)) throw new Error('Ungültige Kontur');
      points += path.points.length;
      if (points > 2000000 || path.points.some((p: any) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
        throw new Error('Ungültige oder zu große Kontur');
      }
    }
  }
}
