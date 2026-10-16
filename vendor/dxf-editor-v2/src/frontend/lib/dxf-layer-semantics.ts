export type DxfPointRole = "turn" | "curve" | "notch" | "other";
export type DxfLayerSemanticRole =
  | "cutBoundary"
  | "sewingLine"
  | "turnMetadata"
  | "curveMetadata"
  | "notch"
  | "validation"
  | "other";

export function normalizeDxfLayer(layer: string | number | null | undefined): string {
  return String(layer ?? "").trim();
}

export function getDxfPointRole(layer: string | number | null | undefined): DxfPointRole {
  switch (normalizeDxfLayer(layer)) {
    case "2":
      return "turn";
    case "3":
      return "curve";
    case "4":
      return "notch";
    default:
      return "other";
  }
}

export function getDxfLayerSemanticRole(
  layer: string | number | null | undefined
): DxfLayerSemanticRole {
  switch (normalizeDxfLayer(layer)) {
    case "1":
      return "cutBoundary";
    case "2":
      return "turnMetadata";
    case "3":
      return "curveMetadata";
    case "4":
      return "notch";
    case "14":
      return "sewingLine";
    case "87":
      return "validation";
    default:
      return "other";
  }
}

export function isTurnCurveMetadataLayer(layer: string | number | null | undefined): boolean {
  const normalized = normalizeDxfLayer(layer);
  return normalized === "2" || normalized === "3";
}

export function isNotchLayer(layer: string | number | null | undefined): boolean {
  return normalizeDxfLayer(layer) === "4";
}

export function isCuttingBoundaryLayer(layer: string | number | null | undefined): boolean {
  return normalizeDxfLayer(layer) === "1";
}

export function isSewingLineLayer(layer: string | number | null | undefined): boolean {
  return normalizeDxfLayer(layer) === "14";
}

export function isValidationRepresentationLayer(layer: string | number | null | undefined): boolean {
  return normalizeDxfLayer(layer) === "87";
}

/**
 * Layers 2/3 are grading metadata and layer 87 is the validation/quality
 * representation of layer 14. They remain available to geometry logic but
 * never become independent physical plot paths.
 */
export function isPhysicalPlotLayer(layer: string | number | null | undefined): boolean {
  return !isTurnCurveMetadataLayer(layer) && !isValidationRepresentationLayer(layer);
}

export function isPhysicalLayerVisible(
  layer: string | number | null | undefined,
  visibleLayers: Set<string> | null | undefined
): boolean {
  const normalized = normalizeDxfLayer(layer);
  if (!isPhysicalPlotLayer(normalized)) return false;
  if (!normalized) return true;
  if (!visibleLayers || visibleLayers.size === 0) return true;
  return visibleLayers.has(normalized);
}

export function getSelectablePhysicalLayers(layers: Iterable<string>): string[] {
  return Array.from(
    new Set(
      Array.from(layers)
        .map(normalizeDxfLayer)
        .filter((layer) => layer && isPhysicalPlotLayer(layer))
    )
  );
}

/**
 * Show every selectable physical layer initially. In graded DXFs layer 14
 * carries the per-size sewing contours, so hiding it makes the file appear to
 * contain only its outer cutting boundary.
 */
export function getDefaultVisiblePhysicalLayers(layers: Iterable<string>): string[] {
  return getSelectablePhysicalLayers(layers);
}

export function getPhysicalLayerLabel(layer: string): string {
  switch (normalizeDxfLayer(layer)) {
    case "1":
      return "1 (Schnittkante)";
    case "4":
      return "4 (Kerben)";
    case "14":
      return "14 (Nählinie)";
    case "15":
      return "15 (Hinweise)";
    default:
      return layer;
  }
}
