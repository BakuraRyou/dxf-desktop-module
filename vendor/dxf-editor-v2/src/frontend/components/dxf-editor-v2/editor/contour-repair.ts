import type { DrawableBlock, DxfFile, Point, PolylinePath } from './types.ts';
import { buildDrawableBlocks, detectHelperBaseSizeFromMarkers, deriveBlockNameMap, extractDrawablePaths, offsetClosedPolylines, pointInPoly } from './util.ts';

export type ContourRepair = { name: string; label: string; before: PolylinePath; after?: PolylinePath; anchorPoints?: Point[]; reason?: string };
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const clean = (points: Point[]) => {
  const result = points.filter((p, i) => !i || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1e-6);
  if (result.length > 1 && Math.hypot(result[0].x - result[result.length - 1].x, result[0].y - result[result.length - 1].y) < 1e-6) result.pop();
  return result;
};
const area = (p: Point[]) => p.reduce((s, a, i) => s + cross(a, p[(i + 1) % p.length]), 0) / 2;
const edges = (p: Point[]) => {
  const sign = Math.sign(area(p));
  return p.map((a, i) => {
    const delta = sub(p[(i + 1) % p.length], a);
    const length = Math.hypot(delta.x, delta.y);
    return { a, delta, normal: { x: sign * delta.y / length, y: -sign * delta.x / length } };
  });
};
export function nearestContourPoint(p: Point, polygon: Point[]) {
  let best = { distance: Infinity, index: 0, t: 0, point: p };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], delta = sub(polygon[(i + 1) % polygon.length], a);
    const length2 = delta.x * delta.x + delta.y * delta.y;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * delta.x + (p.y - a.y) * delta.y) / length2)) : 0;
    const point = { x: a.x + t * delta.x, y: a.y + t * delta.y };
    const distance = Math.hypot(p.x - point.x, p.y - point.y);
    if (distance < best.distance) best = { distance, index: i, t, point };
  }
  return best;
}
const containsOrTouches = (p: Point, polygon: Point[]) => pointInPoly(p, polygon) || nearestContourPoint(p, polygon).distance <= 0.001;

function rayDistance(p: Point, direction: Point, polygon: Point[]): number {
  // A slit can legitimately have no allowance. Do not skip the coincident
  // boundary and measure against an unrelated edge on the far side instead.
  if (nearestContourPoint(p, polygon).distance <= 0.001) return 0;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], delta = sub(polygon[(i + 1) % polygon.length], a);
    const denominator = cross(direction, delta);
    if (Math.abs(denominator) < 1e-9) continue;
    const distance = cross(sub(a, p), delta) / denominator;
    const t = cross(sub(a, p), direction) / denominator;
    if (distance > 0.01 && t >= -1e-7 && t <= 1 + 1e-7) best = Math.min(best, distance);
  }
  return best;
}
export function selfIntersects(p: Point[]): boolean {
  for (let i = 0; i < p.length; i++) for (let j = i + 2; j < p.length; j++) {
    if (i === 0 && j === p.length - 1) continue;
    const a = p[i], b = p[(i + 1) % p.length], c = p[j], d = p[(j + 1) % p.length];
    if (cross(sub(b, a), sub(c, a)) * cross(sub(b, a), sub(d, a)) < -1e-8 &&
        cross(sub(d, c), sub(a, c)) * cross(sub(d, c), sub(b, c)) < -1e-8) return true;
  }
  return false;
}

// Sample the actual base allowance along each source edge. Transfer distances,
// never the distorted target cutting vertices. Ambiguous correspondence is skipped.
export function repairContour(baseOutline: PolylinePath, baseCut: PolylinePath, target: PolylinePath, allowanceControls?: PolylinePath, options: { recalculateUniform?: boolean } = {}): PolylinePath | null {
  const base = clean(baseOutline.points), cut = clean(baseCut.points), points = clean(target.points);
  if (base.length < 3 || cut.length < 3 || points.length !== base.length ||
      Math.sign(area(base)) !== Math.sign(area(points)) || selfIntersects(base) || selfIntersects(cut)) return null;
  // A quality curve can bow between the authoritative sewing controls. Do
  // not interpret that bow as variable allowance when ALL original controls
  // independently agree on a constant width. No fixed garment width is assumed.
  const controlWidths = allowanceControls && allowanceControls.points.length < base.length
    ? clean(allowanceControls.points).map(p=>nearestContourPoint(p,cut).distance) : [];
  const uniformControlWidth = controlWidths.length >= 3 && Math.min(...controlWidths) > 0.01 &&
    Math.max(...controlWidths)-Math.min(...controlWidths) <= 0.02
    ? controlWidths.slice().sort((a,b)=>a-b)[Math.floor(controlWidths.length/2)] : undefined;
  // An unchanged sewing shape needs no reconstructed offset: preserve every
  // corner extension of the base cutting contour, including pocket turnbacks.
  const translation = sub(points[0], base[0]);
  if (!(options.recalculateUniform && uniformControlWidth !== undefined) && base.every((p,i) => Math.hypot(p.x+translation.x-points[i].x,p.y+translation.y-points[i].y) <= 0.001)) {
    return { ...target, points: cut.map(p=>({x:p.x+translation.x,y:p.y+translation.y})),
      closed:true, layer:'1', kind:'seam', semanticRole:'cutBoundary' };
  }
  const profile = edges(base).map(({ a, delta, normal }) => {
    const measure = (t: number) => rayDistance({ x: a.x + delta.x * t, y: a.y + delta.y * t }, normal, cut);
    const midpoint = measure(0.5);
    const localDistance = nearestContourPoint({ x: a.x + delta.x / 2, y: a.y + delta.y / 2 }, cut).distance;
    // Detect a missed local boundary relative to the geometry, not only the
    // absolute upper limit: the far side of a short slit can be below 100 mm.
    if (Number.isFinite(midpoint) && midpoint <= 100 && midpoint <= 2 * localDistance + 0.5) return midpoint;
    // At concave corners the cut edge is shorter than the sewing edge. Its
    // midpoint ray can miss the local allowance and hit a distant boundary.
    // Sample the same edge near both ends before declaring it unmeasurable.
    return Math.min(...[0.01, 0.1, 0.25, 0.75, 0.9, 0.99].map(measure));
  });
  if (profile.some(d => !Number.isFinite(d) || d > 100)) return null;
  let repaired: Point[];
  // Constant allowances use the established polygon offsetter, including concave corners.
  if (uniformControlWidth !== undefined || Math.max(...profile) - Math.min(...profile) <= 0.5) {
    const sorted = profile.slice().sort((a, b) => a - b);
    // Keep the sampled sewing curve: successive local point deletions can
    // accumulate error and turn a dense curve into a coarse polygon.
    const paths = offsetClosedPolylines([{ ...target, points }], uniformControlWidth ?? sorted[Math.floor(sorted.length / 2)], { preserveCurveVertices: true });
    if (paths.length !== 1) return null;
    repaired = paths[0].points;
  } else {
    // Variable allowances require matching contour locations, not just equal
    // point counts. Reject shifted vertex origins or incompatible grading.
    const frame = (p: Point[]) => ({ x: Math.min(...p.map(v => v.x)), y: Math.min(...p.map(v => v.y)),
      w: Math.max(...p.map(v => v.x)) - Math.min(...p.map(v => v.x)),
      h: Math.max(...p.map(v => v.y)) - Math.min(...p.map(v => v.y)) });
    const a = frame(base), b = frame(points);
    if (!(a.w > 0 && a.h > 0 && b.w > 0 && b.h > 0) || base.some((p, i) =>
      Math.hypot((p.x - a.x) / a.w - (points[i].x - b.x) / b.w,
        (p.y - a.y) / a.h - (points[i].y - b.y) / b.h) > 0.2)) return null;
    const shifted = edges(points).map((edge, i) => ({ ...edge, a: {
      x: edge.a.x + edge.normal.x * profile[i], y: edge.a.y + edge.normal.y * profile[i],
    } }));
    repaired = [];
    for (let i = 0; i < shifted.length; i++) {
      const prev = shifted[(i + shifted.length - 1) % shifted.length], next = shifted[i];
      const previousIndex = (i + profile.length - 1) % profile.length;
      const dot = prev.normal.x * next.normal.x + prev.normal.y * next.normal.y;
      // On sampled curves, intersecting near-parallel offset lines amplifies tiny
      // allowance differences into tangential spikes. Move along the averaged
      // normal instead; retain true intersections at distinct corners.
      if (dot > 0.95) {
        const factor = (profile[previousIndex] + profile[i]) / (2 * (1 + dot));
        repaired.push({ x: points[i].x + (prev.normal.x + next.normal.x) * factor,
          y: points[i].y + (prev.normal.y + next.normal.y) * factor });
        continue;
      }
      const den = cross(prev.delta, next.delta);
      if (Math.abs(den) < 1e-8) {
        if (Math.abs(profile[i] - profile[(i + profile.length - 1) % profile.length]) > 0.5) return null;
        repaired.push(next.a); continue;
      }
      const t = cross(sub(next.a, prev.a), next.delta) / den;
      const p = { x: prev.a.x + t * prev.delta.x, y: prev.a.y + t * prev.delta.y };
      if (Math.hypot(p.x - points[i].x, p.y - points[i].y) > 5 * Math.max(profile[i], profile[(i + profile.length - 1) % profile.length])) return null;
      repaired.push(p);
    }
  }
  if (repaired.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || selfIntersects(repaired) || Math.abs(area(repaired)) <= Math.abs(area(points)) || points.some(p => !containsOrTouches(p, repaired))) return null;
  return { ...target, points: repaired, closed: true, layer: '1', kind: 'seam', semanticRole: 'cutBoundary' };
}

/** Fit the LINE to fixed outer notch centers. Markers themselves are never modified. */
export function constrainContourToPoints(contour: PolylinePath, sewing: PolylinePath, anchors: Point[]): PolylinePath | null {
  if (!anchors.length) return contour;
  const points = clean(contour.points), n = points.length;
  const lengths = points.map((p, i) => Math.hypot(p.x - points[(i + 1) % n].x, p.y - points[(i + 1) % n].y));
  const starts = [0];
  for (const length of lengths) starts.push(starts[starts.length - 1] + length);
  const total = starts[n];
  if (!(total > 0)) return null;
  const wrap = (s: number) => ((s % total) + total) % total;
  const arcDistance = (a: number, b: number) => Math.min(Math.abs(a - b), total - Math.abs(a - b));
  const fixed: Array<{ s: number; delta: Point; anchor?: Point; radius: number }> = [];
  for (const anchor of anchors) {
    const hit = nearestContourPoint(anchor, points);
    if (hit.distance > 5) return null;
    const s = wrap(starts[hit.index] + hit.t * lengths[hit.index]);
    const existing = fixed.find(k => arcDistance(k.s, s) < 1e-6);
    if (existing) {
      if (Math.hypot(existing.anchor!.x - anchor.x, existing.anchor!.y - anchor.y) > 0.001) return null;
      continue;
    }
    fixed.push({ s, delta: sub(anchor, hit.point), anchor, radius: Math.min(total / 4, Math.max(20, hit.distance * 8)) });
  }
  const knots = fixed.slice();
  for (const k of fixed) for (const direction of [-1, 1]) {
    const s = wrap(k.s + direction * k.radius);
    if (!fixed.some(other => arcDistance(other.s, s) < other.radius - 1e-6) && !knots.some(other => arcDistance(other.s, s) < 1e-6)) {
      knots.push({ s, delta: { x: 0, y: 0 }, radius: 0 });
    }
  }
  knots.sort((a, b) => a.s - b.s);
  const sourceAt = (s: number) => {
    const index = lengths.findIndex((_, i) => s < starts[i + 1]);
    const i = index < 0 ? n - 1 : index, t = (s - starts[i]) / lengths[i];
    return { x: points[i].x + t * (points[(i + 1) % n].x - points[i].x), y: points[i].y + t * (points[(i + 1) % n].y - points[i].y) };
  };
  // Include exact constraint locations and short intermediate segments so the
  // smooth displacement field is not reduced to a spike on a long source edge.
  const samples = [...starts.slice(0, -1), ...knots.map(k => k.s)];
  for (let i = 0; i < n; i++) {
    const count = Math.ceil(lengths[i] / 3);
    for (let j = 1; j < count; j++) samples.push(starts[i] + lengths[i] * j / count);
  }
  samples.sort((a, b) => a - b);
  const repaired = samples.filter((s, i) => !i || s - samples[i - 1] > 1e-7).map(s => {
    const exact = fixed.find(k => arcDistance(k.s, s) < 1e-7);
    if (exact) return { ...exact.anchor! };
    let next = knots.findIndex(k => k.s > s);
    if (next < 0) next = 0;
    const right = knots[next], left = knots[(next + knots.length - 1) % knots.length];
    const length = wrap(right.s - left.s), t = length > 0 ? wrap(s - left.s) / length : 0;
    const weight = t * t * (3 - 2 * t);
    const p = sourceAt(s);
    return { x: p.x + left.delta.x + weight * (right.delta.x - left.delta.x),
      y: p.y + left.delta.y + weight * (right.delta.y - left.delta.y) };
  });
  if (selfIntersects(repaired) || sewing.points.some(p => !containsOrTouches(p, repaired)) ||
      anchors.some(p => nearestContourPoint(p, repaired).distance > 0.001)) return null;
  return { ...contour, points: repaired };
}

/** Use an exported refinement, never interpolate a new curve from sparse controls. */
export function refineRepairOutline(source: PolylinePath, paths: PolylinePath[]): PolylinePath {
  const controls = clean(source.points);
  const candidates: Point[][] = [];
  for (const path of paths) {
    // Layer 87 carries the detailed sewing curve in these exports. Layer 84
    // can instead be the cutting curve and must not become the sewing line.
    if (path.layer !== '87' || !path.closed || path.points.length <= controls.length) continue;
    let points = clean(path.points);
    if (Math.sign(area(points)) !== Math.sign(area(controls))) points = points.slice().reverse();
    const start = points.findIndex(p => Math.hypot(p.x-controls[0].x,p.y-controls[0].y) <= 0.001);
    if (start < 0) continue;
    points = points.slice(start).concat(points.slice(0,start));
    let cursor = 0;
    const preservesControls = controls.every(control => {
      const index = points.findIndex((p,i) => i >= cursor && Math.hypot(p.x-control.x,p.y-control.y) <= 0.001);
      if (index < 0) return false;
      cursor = index + 1;
      return true;
    });
    const areaRatio = Math.abs(area(points)/area(controls));
    if (!preservesControls || selfIntersects(points) || !Number.isFinite(areaRatio) || areaRatio < 0.95 || areaRatio > 1.05) continue;
    candidates.push(points);
  }
  // Ambiguous quality contours are not a reason to guess a replacement.
  return candidates.length === 1 ? { ...source, points: candidates[0] } : source;
}

export function previewContourRepairs(dxf: DxfFile, baseSize: string, referenceBlocks: DrawableBlock[] = [], options: { includeBase?: boolean } = {}): ContourRepair[] {
  const blocks = dxf.blocks ?? {}, names = deriveBlockNameMap(blocks);
  const autoBase = detectHelperBaseSizeFromMarkers(blocks, names);
  const displayed = new Map(buildDrawableBlocks(blocks, null, { nameMap: names, includeHelperLines: true,
    helperBaseSizeLabel: autoBase, forceHelperBasePropagation: Boolean(autoBase),
  }).map(block => [block.name, block.paths]));
  // Respect the currently displayed marker positions, including a manually
  // selected helper base, instead of silently assuming automatic helper settings.
  for (const block of referenceBlocks) displayed.set(block.name, block.paths);
  const geometries = new Map(Object.entries(blocks).map(([name, block]) => [name, extractDrawablePaths(block, { blocks, blockName: name, includeHelperLines: true })]));
  const single = (name: string, layer: string) => {
    if (layer === '1' && blocks[name]?.repairedCutContour) return blocks[name].repairedCutContour;
    const paths = (geometries.get(name) ?? []).filter(p => p.layer === layer && p.closed && p.points.length >= 3);
    return paths.length === 1 ? (layer === '14' ? refineRepairOutline(paths[0], geometries.get(name) ?? []) : paths[0]) : undefined;
  };
  const result: ContourRepair[] = [];
  for (const [name, info] of names) {
    const isBase = info.sizeLabel?.toLowerCase() === baseSize.toLowerCase();
    if (!info.sizeLabel || (isBase && !options.includeBase)) continue;
    const uniqueCut = single(name, '1');
    const before = uniqueCut ?? (geometries.get(name) ?? []).find(p => p.layer === '1' && p.closed);
    if (!before) continue;
    const bases = [...names].filter(([, n]) => n.pieceLabel === info.pieceLabel && n.sizeLabel?.toLowerCase() === baseSize.toLowerCase());
    const base = bases.length === 1 ? bases[0][0] : '';
    const baseOutline = single(base, '14'), target = single(name, '14');
    // Always measure the exported basis, never a previously repaired override.
    const baseCuts = (geometries.get(base) ?? []).filter(p=>p.layer === '1' && p.closed);
    const baseCut = baseCuts.length === 1 ? baseCuts[0] : undefined;
    let after = uniqueCut && baseOutline && baseCut && target ? repairContour(baseOutline, baseCut, target, (geometries.get(base) ?? []).find(p=>p.layer === '14' && p.closed), { recalculateUniform: isBase }) : null;
    if (isBase && (!after || after.points.every(p=>nearestContourPoint(p, before.points).distance < 0.02))) continue;
    const anchorPoints: Point[] = [];
    if (after && target) for (const marker of displayed.get(name) ?? []) {
      // Only physical notch centers, not curve/turn metadata or construction points.
      if (marker.marker !== 'point' || marker.layer !== '4' || !marker.points.length) continue;
      const center = { x: marker.points.reduce((sum, p) => sum + p.x, 0) / marker.points.length,
        y: marker.points.reduce((sum, p) => sum + p.y, 0) / marker.points.length };
      const sewingDistance = nearestContourPoint(center, target.points).distance;
      const cutDistance = nearestContourPoint(center, after.points).distance;
      // Sewing-line notches must never pull the cut edge inward. A cut notch is
      // outside the sewing contour and clearly closer to the proposed cut edge.
      if (sewingDistance <= 1 || pointInPoly(center, target.points) || cutDistance > Math.min(5, sewingDistance / 2)) continue;
      if (!anchorPoints.some(p => Math.hypot(p.x - center.x, p.y - center.y) < 0.001)) anchorPoints.push(center);
    }
    if (after && target) after = constrainContourToPoints(after, target, anchorPoints);
    result.push({ name, label: `${info.pieceLabel} · ${info.sizeLabel.toUpperCase()}`, before: displayed.get(name)?.find(p => p.layer === '1' && p.closed) ?? before, after: after ?? undefined, anchorPoints,
      reason: after ? undefined : !uniqueCut ? 'Mehrere Außenkonturen vorhanden. Dieses Teil bleibt unverändert.' : !base ? 'Keine eindeutige Basisgröße für dieses Schnittteil.' : 'Nahtzugabe oder Kurvenzuordnung nicht eindeutig. Dieses Teil bleibt unverändert.' });
  }
  return result;
}

export function applyContourRepairs(dxf: DxfFile, repairs: ContourRepair[]): DxfFile {
  const blocks = { ...dxf.blocks };
  for (const repair of repairs) {
    if (!repair.after || !blocks[repair.name]) continue;
    const original = blocks[repair.name];
    blocks[repair.name] = { ...original, repairedCutContour: {
      ...repair.after, points: repair.after.points.map(p => ({ ...p })),
    } };
  }
  return { ...dxf, blocks };
}
