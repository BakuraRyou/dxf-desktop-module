export const MAX_BOUNDING_TIME_MS = 24 * 60 * 60 * 1000;
export const isValidBoundingTimeBudget = (value: number) => Number.isFinite(value) && value >= 1000 && value <= MAX_BOUNDING_TIME_MS;

export type BoundingMode = 'hybrid' | 'extreme' | 'real' | 'standard';
export type BoundingSettings = {
  workers?: number;
  mode: BoundingMode;
  timeBudgetMs: number;
  maxLengthMm: number | null;
  stopAtTarget: boolean;
  gridMm: number;
  iterations: number;
  fabricWidth: number;
  rotationStep: number;
};

export function validateBoundingSettings(value: BoundingSettings): string | null {
  if (value.workers !== undefined && ![1, 2, 3].includes(value.workers)) return 'Wähle ein bis drei gleichzeitige Suchläufe.';
  if (!['hybrid', 'extreme', 'real', 'standard'].includes(value.mode)) return 'Wähle einen Packmodus.';
  if (!isValidBoundingTimeBudget(value.timeBudgetMs)) return 'Gib eine Suchdauer zwischen 1 und 86.400 Sekunden ein.';
  if (!Number.isFinite(value.fabricWidth) || value.fabricWidth <= 0 || value.fabricWidth > 100000) return 'Gib eine Stoffbreite zwischen 0 und 100.000 mm ein.';
  if (value.maxLengthMm !== null && (!Number.isFinite(value.maxLengthMm) || value.maxLengthMm <= 0 || value.maxLengthMm > 1000000)) return 'Gib eine maximale Stofflänge zwischen 0 und 1.000.000 mm ein oder lass das Feld frei.';
  if (!Number.isFinite(value.rotationStep) || value.rotationStep < 0 || value.rotationStep > 180) return 'Wähle eine Rotation zwischen 0 und 180 Grad.';
  if (![2, 3, 5].includes(value.gridMm)) return 'Wähle eine Suchgenauigkeit.';
  if (!Number.isInteger(value.iterations) || value.iterations < 1 || value.iterations > 10000) return 'Wähle zwischen 1 und 10.000 Durchläufen.';
  return null;
}

export const lengthTargetReached = (height: number, target?: number | null) =>
  !!target && Number.isFinite(height) && height < target - 0.0001;
