import {
  packDrawableBlocks,
  progressivePackDrawableBlocks,
  progressivePackDrawableBlocksPoly,
} from "../components/dxf-editor-v2/editor/util.ts";
import type {
  PackingExecutionMessage,
  PackingExecution,
  AttemptMessage,
  DoneMessage,
  ErrorMessage,
  InitOkMessage,
  PackRequest,
  ProgressMessage,
  SearchProgressMessage,
  StoppedMessage,
  WorkerPreviewPlacement,
  WorkerMessage,
} from "../components/dxf-editor-v2/editor/types.ts";
import type { PolyRasterBackend, ContinuousNestingBackend } from "../components/dxf-editor-v2/editor/types.ts";

export function installPackingRuntime(workerScope: any, rasterBackend: PolyRasterBackend, nestingBackend?: ContinuousNestingBackend, execution: { location: PackingExecution['location']; rasterBackend: 'rust-native' | 'rust-wasm' } = {location:'browser',rasterBackend:'rust-wasm'}) {

let stopRequested = false;
let cachedBlocks: PackRequest["blocks"] = null;



const post = (message: PackingExecutionMessage | InitOkMessage | SearchProgressMessage | ProgressMessage | AttemptMessage | DoneMessage | ErrorMessage | StoppedMessage) => {
  workerScope.postMessage(message);
};

const runPack = async (request: PackRequest) => {
  let lastBackend: PackingExecution['backend'] | undefined;
  const reportBackend = (backend: PackingExecution['backend']) => {
    if (stopRequested || backend === lastBackend) return;
    lastBackend = backend;
    post({type:'packing-execution',location:execution.location,backend});
  };
  reportBackend('preparing');
  const trackedRasterBackend: PolyRasterBackend = async input => {
    reportBackend(execution.rasterBackend);
    return rasterBackend(input);
  };
  const trackedNestingBackend: ContinuousNestingBackend | undefined = nestingBackend && (async input => {
    try {
      await nestingBackend({...input,onStart: info => { reportBackend('native-nesting'); input.onStart?.(info); }});
    } finally { reportBackend('javascript'); }
  });
  const {
    blocks,
    fabricWidth,
    rotationStep,
    useRealBounding,
    maxRandomOrders,
    useCache,
    fast,
    outlineMarginMm,
    reportProgress,
    reportPreview,
    grid,
    vectorGuard,
    compactionPasses,
    extreme,
    targetLengthMm, stopAtTarget, modelCandidates, initialLayout,
  } = request;
  const effectiveBlocks = useCache ? cachedBlocks : blocks;
  if (!effectiveBlocks) throw new Error("Keine Blöcke geladen (cache leer)");
  const blockIndexes = new Map(effectiveBlocks.map((block, index) => [block, index]));
  let lastPreviewAt = 0;
  let lastAttempt = 1;
  let totalAttempts = Math.max(1, maxRandomOrders ?? 1);
  const previewPlacements = (placements: DoneMessage["placements"]): WorkerPreviewPlacement[] =>
    placements.map((placement) => {
      const anchor = placement.variant.renderBounds ?? placement.variant.bounds;
      return {
        blockIndex: blockIndexes.get(placement.block) ?? -1,
        x: placement.x, y: placement.y,
        width: placement.width, height: placement.height,
        angle: placement.variant.angle,
        anchorMinX: anchor.minX, anchorMinY: anchor.minY,
      };
    });

  if (fast && !extreme && !targetLengthMm) {
    if (useRealBounding) {
      return progressivePackDrawableBlocksPoly(effectiveBlocks, fabricWidth, rotationStep, {
        maxRandomOrders: Math.max(1, Math.min(4, maxRandomOrders)),
        outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
        grid,
        vectorGuard,
        compactionPasses,
        rasterBackend: trackedRasterBackend,
        onBackend: state => reportBackend(state.backend),
      });
    }
    return packDrawableBlocks(effectiveBlocks, fabricWidth, rotationStep, {
      orderTrials: Math.max(1, Math.min(4, maxRandomOrders)),
      outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
    });
  }

  const pack = useRealBounding ? progressivePackDrawableBlocksPoly : progressivePackDrawableBlocks;
  const result = await pack(effectiveBlocks, fabricWidth, rotationStep, {
    maxRandomOrders,
    shouldStop: () => stopRequested,
    outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
    grid,
    vectorGuard,
    compactionPasses,
    rasterBackend: useRealBounding ? trackedRasterBackend : undefined,
    onBackend: state => reportBackend(state.backend),
    extreme, targetLengthMm, stopAtTarget, modelCandidates, initialLayout,
    nestingBackend: useRealBounding ? trackedNestingBackend : undefined,
    onSearchProgress: (state) => {
      if (!stopRequested) post({ type: "search-progress", ...state });
    },
    onPlacement: reportProgress === false && reportPreview !== true
      ? undefined
      : (partial) => {
        if (stopRequested) return;
        if ('phase' in partial && partial.phase === 'compacting') reportBackend('javascript');
        lastAttempt = partial.attempt;
        totalAttempts = partial.totalAttempts;
        const now = Date.now();
        const includePreview =
          reportPreview === true &&
          (partial.placed === partial.total || now - lastPreviewAt >= 200);
        if (reportProgress === false && !includePreview) return;
        if (includePreview) lastPreviewAt = now;
        post({
          type: "progress",
          phase: "phase" in partial ? partial.phase as "compacting" | undefined : undefined,
          usedHeight: partial.usedHeight,
          placed: partial.placed,
          total: partial.total,
          attempt: partial.attempt,
          totalAttempts: partial.totalAttempts,
          bestHeight: partial.bestHeight,
          previewPlacements: includePreview ? previewPlacements(partial.placements) : undefined,
        });
      },
    onAttemptResult: reportProgress === false
      ? undefined
      : (result) => {
        if (stopRequested) return;
        post({
          type: "attempt",
          attempt: result.attempt,
          totalAttempts: result.totalAttempts,
          usedHeight: result.usedHeight,
          waste: result.waste,
          placements: result.placements,
        });
      },
  });
  // The last attempted layout can be worse than the selected result. End the
  // preview with the very same layout that is delivered to the editor.
  if (result && useRealBounding && reportPreview && !stopRequested) {
    post({
      type: "progress", placed: result.placements.length, total: effectiveBlocks.length,
      attempt: lastAttempt, totalAttempts, usedHeight: result.usedHeight,
      bestHeight: result.usedHeight, previewPlacements: previewPlacements(result.placements),
    });
  }
  return result;
};

workerScope.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const data = event.data;
  if (!data) return;

  if (data.type === "stop") {
    stopRequested = true;
    return;
  }

  if (data.type === "initBlocks") {
    cachedBlocks = data.blocks || null;
    stopRequested = false;
    post({ type: "init-ok" });
    return;
  }

  if (data.type !== "pack") return;

  stopRequested = false;
  try {
    const result = await runPack(data.payload);
    if (stopRequested) {
      post({ type: "stopped" });
    } else if (result) {
      post({
        type: "done",
        placements: result.placements,
        usedHeight: result.usedHeight,
      });
    } else {
      post({ type: "error", message: "Keine Platzierung gefunden." });
    }
  } catch (error: any) {
    post({ type: "error", message: error?.message || String(error) });
  }
};

}
