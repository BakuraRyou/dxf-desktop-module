import type { DrawableBlock, DxfFile, Point, PolylinePath } from './types.ts';
import { deriveBlockNameMap, extractDrawablePaths, pointInPoly } from './util.ts';
import { nearestContourPoint } from './contour-repair.ts';

export type ContourWarning = { name: string; label: string };
const single = (paths: PolylinePath[], layer: string) => {
  const candidates = paths.filter(p => p.closed && p.layer === layer && p.points.length >= 3);
  return candidates.length === 1 ? candidates[0] : undefined;
};
const vertices = (path: PolylinePath): Point[] => {
  const points = path.points;
  const first = points[0], last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) < 0.001 ? points.slice(0, -1) : points;
};

/** Compare allowances at corresponding sewing locations, not garment dimensions:
 * a larger size must grow, but its allowance should remain close to the basis.
 * Use displayed cut geometry so valid copied-boundary exports are not flagged.
 * This is a conservative hint, never an instruction to modify a contour.
 */
export function detectContourWarnings(dxf: DxfFile, baseSize: string, drawables: DrawableBlock[]): ContourWarning[] {
  if (!baseSize || !dxf.blocks) return [];
  const names = deriveBlockNameMap(dxf.blocks);
  const rows = drawables.map(block => ({
    block, info: names.get(block.name), cut: single(block.paths, '1'),
    sewing: single(extractDrawablePaths(dxf.blocks![block.name], {
      blocks: dxf.blocks, blockName: block.name,
    }), '14'),
  }));
  const result: ContourWarning[] = [];
  for (const row of rows) {
    if (!row.info?.sizeLabel || row.info.sizeLabel.toLowerCase() === baseSize.toLowerCase() || !row.cut || !row.sewing) continue;
    const bases = rows.filter(b => b.info?.pieceLabel === row.info!.pieceLabel && b.info?.sizeLabel?.toLowerCase() === baseSize.toLowerCase());
    if (bases.length !== 1 || !bases[0].cut || !bases[0].sewing) continue;
    const base = vertices(bases[0].sewing), target = vertices(row.sewing);
    // Without corresponding authored vertices there is no reliable comparison.
    if (base.length !== target.length) continue;
    const lengths = target.map((p, i) => Math.hypot(p.x - target[(i + 1) % target.length].x, p.y - target[(i + 1) % target.length].y));
    const perimeter = lengths.reduce((sum, n) => sum + n, 0);
    if (!Number.isFinite(perimeter) || perimeter <= 0) continue;
    let edge = 0, start = 0, suspicious = 0;
    // Uniform arc-length sampling avoids giving dense curve vertices more
    // influence than long straight edges, and bounds the cost per piece.
    for (let sample = 0; sample < 128; sample++) {
      const distance = perimeter * (sample + 0.5) / 128;
      while (edge < lengths.length - 1 && start + lengths[edge] < distance) start += lengths[edge++];
      const t = lengths[edge] > 0 ? (distance - start) / lengths[edge] : 0;
      const at = (points: Point[]): Point => ({
        x: points[edge].x + t * (points[(edge + 1) % points.length].x - points[edge].x),
        y: points[edge].y + t * (points[(edge + 1) % points.length].y - points[edge].y),
      });
      const source = at(base), point = at(target);
      const allowance = nearestContourPoint(source, bases[0].cut.points).distance;
      const hit = nearestContourPoint(point, row.cut.points).distance;
      // A sewing line outside the cut boundary is a stronger discrepancy.
      const actual = hit <= 0.001 || pointInPoly(point, row.cut.points) ? hit : -hit;
      const deviation = Math.abs(actual - allowance);
      if (deviation > Math.max(3, allowance * 0.35)) suspicious++;
    }
    // Require a discrepancy on at least 10% of the perimeter, beyond
    // both 3 mm and 35% of the local allowance. Isolated corners are ignored.
    if (suspicious >= 13) {
      result.push({ name: row.block.name, label: `${row.info.pieceLabel} · ${row.info.sizeLabel.toUpperCase()}` });
    }
  }
  return result;
}
