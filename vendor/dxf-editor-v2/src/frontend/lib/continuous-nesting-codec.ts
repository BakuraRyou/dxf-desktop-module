import ClipperLib from 'clipper-lib';
import type { ContinuousNestingBackend, PolyPackedItem, Point } from '../components/dxf-editor-v2/editor/types.ts';

const normalize = (angle: number) => ((angle % 360) + 360) % 360;
function hull(points: Point[]) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list: Point[]) => { const stack: Point[] = []; for (const p of list) { while (stack.length >= 2 && cross(stack[stack.length - 2], stack[stack.length - 1], p) <= 0) stack.pop(); stack.push(p); } return stack; };
  return [...half(sorted).slice(0, -1), ...half(sorted.slice().reverse()).slice(0, -1)];
}
function itemGeometry(item: PolyPackedItem) {
  const source = (item.block.packPaths?.length ? item.block.packPaths : item.block.paths)
    .filter(p => p.closed && p.points.length >= 3).map(p => p.points);
  if (!source.length) throw new Error('Keine geschlossene Kontur');
  const CL: any = (ClipperLib as any)?.default ?? ClipperLib;
  const paths = source.map(points => {
    const p = points.map(p => ({ X: Math.round(p.x * 1000), Y: Math.round(p.y * 1000) }));
    if (CL.Clipper.Area(p) < 0) p.reverse(); return p;
  });
  const clipper = new CL.Clipper();
  clipper.AddPaths(paths, CL.PolyType.ptSubject, true);
  const union: any[] = [];
  clipper.Execute(CL.ClipType.ctUnion, union, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
  const outer = union.filter(p => CL.Clipper.Area(p) > 0).map(p => p.map((v: any) => ({ x: v.X / 1000, y: v.Y / 1000 })));
  // Sparrow supports a single outer boundary. Fill holes; enclose disconnected
  // islands conservatively instead of silently dropping material.
  const contour: Point[] = outer.length === 1 ? outer[0] : hull(outer.flat());
  if (contour.length < 3) throw new Error('Keine gültige Außenkontur');
  const minX = item.block.bounds.minX, minY = item.block.bounds.minY;
  const original = source.flat().map(p => ({ x: p.x - minX, y: p.y - minY }));
  const bounds = (angle: number) => {
    const rad = angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    let x = Infinity, y = Infinity;
    for (const p of original) { x = Math.min(x, p.x * cos - p.y * sin); y = Math.min(y, p.x * sin + p.y * cos); }
    return { x, y };
  };
  return { bounds, angles: item.variants.map(v => v.variant.angle),
    // Swap the coordinate axes for Sparrow's horizontal strip; invert rotations
    // on import/export. This coordinate change never reflects an individual item.
    shape: contour.map(p => [p.y - minY, p.x - minX]) };
}
export function createNativeProblem(input: Parameters<ContinuousNestingBackend>[0]) {
  const geometry = input.items.map(itemGeometry);
  const indices = new Map(input.items.map((item, i) => [item.block, i]));
  const encodeSeed = (seed: typeof input.seed) => {
    const placed = seed.placements.map(p => {
      const index = indices.get(p.block);
      if (index === undefined) throw new Error('Unbekanntes Schnittteil');
      const local = geometry[index].bounds(p.variant.angle);
      const points = (p.variant.packPaths?.length ? p.variant.packPaths : p.variant.paths).filter(v => v.closed).flatMap(v => v.points);
      const anchor = p.variant.renderBounds ?? p.variant.bounds;
      const x = p.x + Math.min(...points.map(v => v.x)) - anchor.minX;
      const y = p.y + Math.min(...points.map(v => v.y)) - anchor.minY;
      return { item_id: index, transformation: { rotation: normalize(-p.variant.angle), translation: [y - local.y, x - local.x], reflected: false } };
    });
    return { strip_width: seed.usedHeight + .1, density: 0, run_time_sec: 0, layout: { container_id: 0, density: 0, placed_items: placed } };
  };
  const request = {
    instance: { name: 'animatus', strip_height: input.fabricWidth, min_item_separation: 0.02,
      items: geometry.map((g, id) => ({ id, demand: 1, orientation: { rotation: { mode: 'discrete', angles: g.angles.map(a => normalize(-a)) }, reflection_axes: [] },
        shape: { type: 'simple_polygon', data: g.shape } })) },
    solution: encodeSeed(input.seed),
    warmSolution: input.warmSeed ? encodeSeed(input.warmSeed) : undefined,
    timeBudgetMs: Math.max(100, Math.floor(input.timeBudgetMs)),
    targetLengthMm: input.targetLengthMm, stopAtTarget: input.stopAtTarget,
  };
  function decode(solution: any) {
    const list = solution?.layout?.placed_items;
    if (!Array.isArray(list) || list.length !== geometry.length) throw new Error('Unvollständige native Anordnung');
    const seen = new Set<number>();
    return list.map(p => {
      const index = p.item_id, t = p.transformation;
      if (!Number.isInteger(index) || index < 0 || index >= geometry.length || seen.has(index)
        || t?.reflected || !Array.isArray(t?.translation) || t.translation.length !== 2
        || ![t.rotation, ...t.translation].every(Number.isFinite)) throw new Error('Ungültige native Platzierung');
      seen.add(index);
      const angle = normalize(-t.rotation);
      const allowed = geometry[index].angles.find(a => Math.abs(normalize(a - angle + 180) - 180) < .001);
      if (allowed === undefined) throw new Error('Nicht erlaubte native Drehung');
      const local = geometry[index].bounds(allowed);
      return { blockIndex: index, x: t.translation[1] + local.x, y: t.translation[0] + local.y, angle: allowed };
    });
  }
  const height = (layout: ReturnType<typeof decode>) => Math.max(...layout.map(p => p.y + input.items[p.blockIndex].variants.find(v => Math.abs(normalize(v.variant.angle - p.angle + 180) - 180) < .001)!.variant.height));
  return { request, decode, height };
}
