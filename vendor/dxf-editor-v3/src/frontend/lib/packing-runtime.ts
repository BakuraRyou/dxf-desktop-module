import {
  packDrawableBlocks,
  progressivePackDrawableBlocks,
  progressivePackDrawableBlocksPoly,
} from "../components/dxf-editor-v3/editor/util.ts";
import type {
  AttemptMessage,
  DoneMessage,
  ErrorMessage,
  InitOkMessage,
  PackRequest,
  ProgressMessage,
  StoppedMessage,
  WorkerPreviewPlacement,
  WorkerMessage,
} from "../components/dxf-editor-v3/editor/types.ts";
import type { PolyRasterBackend } from "../components/dxf-editor-v3/editor/types.ts";

export function installPackingRuntime(workerScope: any, rasterBackend: PolyRasterBackend) {

let stopRequested = false;
let cachedBlocks: PackRequest["blocks"] = null;



const post = (message: InitOkMessage | ProgressMessage | AttemptMessage | DoneMessage | ErrorMessage | StoppedMessage) => {
  workerScope.postMessage(message);
};

const runPack = async (request: PackRequest) => {
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
  } = request;
  const effectiveBlocks = useCache ? cachedBlocks : blocks;
  if (!effectiveBlocks) throw new Error("Keine Blöcke geladen (cache leer)");
  const blockIndexes = new Map(effectiveBlocks.map((block, index) => [block, index]));
  let lastPreviewAt = 0;

  if (fast) {
    if (useRealBounding) {
      return progressivePackDrawableBlocksPoly(effectiveBlocks, fabricWidth, rotationStep, {
        maxRandomOrders: Math.max(1, Math.min(4, maxRandomOrders)),
        outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
        grid,
        vectorGuard,
        compactionPasses,
        rasterBackend: rasterBackend,
      });
    }
    return packDrawableBlocks(effectiveBlocks, fabricWidth, rotationStep, {
      orderTrials: Math.max(1, Math.min(4, maxRandomOrders)),
      outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
    });
  }

  const pack = useRealBounding ? progressivePackDrawableBlocksPoly : progressivePackDrawableBlocks;
  return pack(effectiveBlocks, fabricWidth, rotationStep, {
    maxRandomOrders,
    shouldStop: () => stopRequested,
    outlineMarginMm: Math.max(0, outlineMarginMm ?? 0),
    grid,
    vectorGuard,
    compactionPasses,
    rasterBackend: useRealBounding ? rasterBackend : undefined,
    onPlacement: reportProgress === false && reportPreview !== true
      ? undefined
      : (partial) => {
        if (stopRequested) return;
        const now = Date.now();
        const includePreview =
          reportPreview === true &&
          (partial.placed === partial.total || now - lastPreviewAt >= 200);
        if (reportProgress === false && !includePreview) return;
        if (includePreview) lastPreviewAt = now;
        const previewPlacements: WorkerPreviewPlacement[] | undefined = includePreview
          ? partial.placements.map((placement) => ({
            blockIndex: blockIndexes.get(placement.block) ?? -1,
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
            angle: placement.variant.angle,
            anchorMinX: placement.variant.bounds.minX,
            anchorMinY: placement.variant.bounds.minY,
          }))
          : undefined;
        post({
          type: "progress",
          usedHeight: partial.usedHeight,
          placed: partial.placed,
          total: partial.total,
          attempt: partial.attempt,
          totalAttempts: partial.totalAttempts,
          bestHeight: partial.bestHeight,
          previewPlacements,
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
