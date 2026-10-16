export type ModelCandidates = {
  orders: number[][];
  layouts: Array<Array<{ blockIndex: number; x: number; y: number; angle: number }>>;
};
export type BoundingModelsStatus = {
  ready: boolean;
  reason?: 'desktop-required' | 'module-update' | 'missing-models';
  models: Array<{ id: 'nester' | 'rl4co'; ready: boolean; maxPieces?: number }>;
};
