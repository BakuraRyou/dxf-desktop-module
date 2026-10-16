
export type PolyProgressiveOptions = {
  onPlacement?: (state: { placements: PlacedDrawableBlock[]; usedHeight: number; placed: number; total: number; attempt: number; totalAttempts: number; bestHeight?: number }) => void;
  onPruned?: (state: { usedHeight: number; maxUsedHeightExclusive: number; placed: number; total: number; attempt: number; totalAttempts: number }) => void;
  shouldStop?: () => boolean;
  maxRandomOrders?: number;
  maxUsedHeightExclusive?: number;
  randomizeFirstOrder?: boolean;
  resolveOrderUnit?: (space: {
    totalUnits: string;
    orderSpaceKey: string;
    pieceCount: number;
    equivalentPieceGroups: number[];
  }) => Promise<string>;
  onAttemptResult?: (result: { placements: PlacedDrawableBlock[]; usedHeight: number; attempt: number; totalAttempts: number; waste: number }) => void;
  outlineMarginMm?: number;
  vectorGuard?: boolean;
  compactionPasses?: number;
  grid?: number;
  rasterBackend?: PolyRasterBackend;
  onBackend?: (state: PolyPackingBackendState) => void;
};

export type PolyProgressiveAttemptOptions = PolyProgressiveOptions & {
  attempt: number;
  totalAttempts: number;
  totalPieces: number;
  fabricWidth: number;
  bestHeight?: number;
  vectorGuard?: boolean;
  grid?: number;
};


export type PolyProgressiveResult = {
  result: { placements: PlacedDrawableBlock[]; usedHeight: number } | null;
  stopped: boolean;
  pruned: boolean;
};
export type PolylineTypeHints = { blocks: Map<string, Array<number | undefined>>; entities: Array<number | undefined> };

export type DxfParserModule = { default?: any } & { DxfParser?: any };

// --- Types matching the server route (simplified where safe for client) ---
export type Point = { x: number; y: number };
export type PolylinePath = {
  points: Point[];
  closed: boolean;
  layer?: string;
  kind?: "outline" | "seam" | "helper";
  semanticRole?: "cutBoundary" | "sewingLine" | "turnMetadata" | "curveMetadata" | "notch" | "validation" | "other";
  polyType?: number;
  /**
   * Marker metadata for derived geometry (e.g. DXF POINT -> tiny cross).
   * Used to keep helper-scaling heuristics from treating point markers as real helper curves.
   */
  marker?: "point";
  pointRole?: "turn" | "curve" | "notch" | "other";
};
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
export type PackedVariant = {
    variant: BlockVariant;
    width: number;
    height: number;
    padX: number;
    padY: number;
    paddedWidth: number;
    paddedHeight: number;
    paddedArea: number;
};

export type PackedItem = {
    id: number;
    block: DrawableBlock;
    variants: PackedVariant[];
    maxArea: number;
    minArea: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
};

export type PackNode = { x: number; y: number; width: number; height: number; used?: boolean; right?: PackNode; down?: PackNode };
export type SavedLayoutJsonV1 = {
  type: "animatus-layout";
  version: 1;
  createdAt: string;
  styleId?: string | number | null;
  source?: {
    dxfAppPath?: string | null;
  };
  // Full parsed DXF (blocks/entities/points). This makes the layout JSON self-contained.
  dxf?: DxfFile | null;
  settings: {
    fabricWidth: number;
    rotationStep: number;
    includeHelperLines: boolean;
    // Deprecated (kept optional for backwards compatibility with older saved layouts).
    fixHelperScaling?: boolean;
    helperBaseSize: string | "auto";
    useOriginalLayout?: boolean;
    useRealBounding?: boolean;
    targetHeightMm?: number;
    showText?: boolean;
    labelHeightMm?: number;
    showBoundingBoxes?: boolean;
    outlineEnabled?: boolean;
    syntheticCutFallbackVersion?: 1;
    mirrorPltOutput?: boolean;
    showScannerErrorRects?: boolean;
    showGradeErrorRects?: boolean;
    layerSemanticsVersion?: 4;
    visibleLayers: string[] | null;
    visibleGroups: string[] | null;
    selectedSizes: string[] | null;
    selectedPolyTypes?: string[] | null;
    rotatablePieces: string[] | null;
    hiddenErrorKeys?: string[] | null;
  };
  layout: {
    usedHeight: number;
    placements: Array<{
      blockName: string;
      blockNameSanitized?: string;
      x: number;
      y: number;
      angle?: number;
      pieceLabel?: string;
      sizeLabel?: string;
      snapshot?: {
        block: DrawableBlock;
        variant: BlockVariant;
        width: number;
        height: number;
      };
    }>;
  };
};

export type PolyVariant = {
    variant: BlockVariant;
    mask: boolean[][]; // [y][x]
    bitRows?: Uint32Array[];
    maskW: number;
    maskH: number;
    cell: number;
};

export type PolyPackedItem = {
    block: DrawableBlock;
    variants: PolyVariant[];
    area: number;
};


export type ProgressivePackOptions = {
    onPlacement?: (state: { placements: PlacedDrawableBlock[]; usedHeight: number; placed: number; total: number; attempt: number; totalAttempts: number; bestHeight?: number }) => void;
    shouldStop?: () => boolean;
    maxRandomOrders?: number;
    onAttemptResult?: (result: { placements: PlacedDrawableBlock[]; usedHeight: number; attempt: number; totalAttempts: number; waste: number }) => void;
    outlineMarginMm?: number;
};

export type ProgressiveAttemptOptions = ProgressivePackOptions & {
    attempt: number;
    totalAttempts: number;
    totalPieces: number;
    bestHeight?: number;
    totalArea: number;
    fabricWidth: number;
};
export type DrawPathOptions = {
    includeHelperLines?: boolean;
    blocks?: Record<string, DxfBlock>;
    blockName?: string;
    visited?: Set<string>;
    fixHelperScaling?: boolean;
};


export type InsertTransform = { translationX: number; translationY: number; rotation: number; scaleX: number; scaleY: number };


export type DxfAnnotation = {
  text: string;
  position: Point;
  height: number;
  rotation: number;
  layer: string;
};

export type DrawableBlock = {
  polyType: any;
  groupId: any;
  name: string;
  pieceLabel: string;
  sizeLabel?: string;
  rotationStepOverride?: number | null;
  manualAngleOverride?: number | null;
  paths: PolylinePath[];
  annotations?: DxfAnnotation[];
  packPaths: PolylinePath[];
  bounds: Bounds; // packing bounds (may include helpers when shown)
  outlineBounds?: Bounds; // optional outline bounds for parity with main thread blocks
  width: number;
  height: number;
};

export type BlockVariant = {
  block: DrawableBlock;
  angle: number;
  bounds: Bounds;
  renderBounds: Bounds;
  width: number;
  height: number;
  paths: PolylinePath[];
  packPaths: PolylinePath[];
  exportPaths?: PolylinePath[];
};

export type PlacedDrawableBlock = {
  block: DrawableBlock;
  variant: BlockVariant;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PlacementInfo = {
  placement: PlacedDrawableBlock;
  bounds: Bounds;
  polygons: Point[][];
};

export type DxfBlock = {
  name: string;
  entities?: DxfEntity[];
  /** Explicit user-approved cut contour, persisted with saved documents. */
  repairedCutContour?: PolylinePath;
};
export type DxfFile = { blocks?: Record<string, DxfBlock>; entities?: DxfEntity[] };


export type PackRequest = {
  blocks?: DrawableBlock[];
  fabricWidth: number;
  rotationStep: number | null;
  useRealBounding: boolean;
  maxRandomOrders: number;
  outlineMarginMm?: number;
  useCache?: boolean;
  fast?: boolean;
  reportProgress?: boolean;
  reportPreview?: boolean;
  grid?: number;
  vectorGuard?: boolean;
  compactionPasses?: number;
};

export type PolyRasterBackendInput = {
  order: PolyPackedItem[];
  fabricCells: number;
  fabricWidth: number;
  cell: number;
};

export type PolyRasterBackendResult = {
  backend: "rust-native" | "rust-wasm";
  durationMs: number;
  choices: Array<{
    variantIndex: number;
    x: number;
    y: number;
    top: number;
  }>;
};

export type PolyPackingBackendState = {
  backend: "rust-native" | "rust-wasm" | "javascript";
  durationMs: number;
  reason?: string;
};

export type PolyRasterBackend = (
  input: PolyRasterBackendInput
) => Promise<PolyRasterBackendResult | null>;

export type WorkerPreviewPlacement = {
  blockIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  anchorMinX: number;
  anchorMinY: number;
};

export type DxfEntity = {
  type: string;
  text?: string;
  textHeight?: number;
  vertices?: Array<{ x: number; y: number; layer?: string | number; bulge?: number }>;
  shape?: boolean;
  closed?: boolean;
  name?: string;
  position?: Point;
  rotation?: number;
  scale?: number;
  xScale?: number;
  yScale?: number;
  layer?: string | number;
  polyType?: number; // DXF group code 250 captured from POLYLINE header

  // Optional fields for curved primitives (from dxf-parser)
  center?: Point;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
};

export type WorkerMessage =
  | { type: "pack"; payload: PackRequest }
  | { type: "stop" }
  | { type: "initBlocks"; blocks: DrawableBlock[] };

export type ProgressMessage = {
  type: "progress";
  placed: number;
  total: number;
  attempt: number;
  totalAttempts: number;
  usedHeight: number;
  bestHeight?: number;
  previewPlacements?: WorkerPreviewPlacement[];
};

export type AttemptMessage = {
  type: "attempt";
  attempt: number;
  totalAttempts: number;
  usedHeight: number;
  waste: number;
  placements: PlacedDrawableBlock[];
};

export type InitOkMessage = { type: "init-ok" };
export type DoneMessage = { type: "done"; placements: PlacedDrawableBlock[]; usedHeight: number };
export type ErrorMessage = { type: "error"; message: string };
export type StoppedMessage = { type: "stopped" };

export type OutMessage = ProgressMessage | AttemptMessage | DoneMessage | ErrorMessage | StoppedMessage | InitOkMessage;


export type PackResult = { placements: PlacedDrawableBlock[]; usedHeight: number };
