import type { DrawableBlock, PlacedDrawableBlock, PackingStartLayout } from '../components/dxf-editor-v2/editor/types';

/** Include actual vertices: contour repairs can preserve names, counts and bounds. */
export function packingGeometrySignature(blocks: DrawableBlock[], fabricWidth: number, rotationStep: number | null, includeRules = true): string {
  let a = 2166136261, b = 2246822519;
  const feed = (value: unknown) => {
    const text = JSON.stringify(value) ?? 'undefined';
    for (let i = 0; i < text.length; i++) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b ^ text.charCodeAt(i), 3266489917); }
    a = Math.imul(a ^ 255, 16777619); b = Math.imul(b ^ 255, 3266489917);
  };
  feed(fabricWidth); feed(rotationStep); feed(blocks.length);
  for (const block of blocks) {
    feed(block.name); if (includeRules) { feed(block.rotationStepOverride); if (block.rotationGroupAngles?.length) feed(block.rotationGroupAngles); else feed(block.manualAngleOverride); if (block.rotationGroup) feed(block.rotationGroup); }
    const paths = (block.packPaths?.length ? block.packPaths : block.paths).filter(p => p.closed && p.points.length >= 3);
    feed(paths.length);
    for (const path of paths) { feed(path.points.length); for (const p of path.points) { feed(p.x); feed(p.y); } }
  }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
}

export function createPackingStartLayout(placements: PlacedDrawableBlock[], blocks: DrawableBlock[], fabricWidth: number, rotationStep: number | null): PackingStartLayout | null {
  if (placements.length !== blocks.length || !blocks.length) return null;
  const indices = new Map(blocks.map((block, index) => [block.name, index]));
  if (indices.size !== blocks.length) return null;
  const seen = new Set<number>();
  const layout = [];
  for (const p of placements) {
    const index = indices.get(p.block.name);
    if (index === undefined || seen.has(index)) return null;
    if (packingGeometrySignature([p.block], fabricWidth, rotationStep, false) !== packingGeometrySignature([blocks[index]], fabricWidth, rotationStep, false)) return null;
    const source = (p.variant.packPaths?.length ? p.variant.packPaths : p.variant.paths).filter(v => v.closed && v.points.length >= 3);
    if (!source.length) return null;
    let minX = Infinity, minY = Infinity;
    for (const path of source) for (const point of path.points) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); }
    const anchor = p.variant.renderBounds ?? p.variant.bounds;
    const x = p.x + minX - anchor.minX, y = p.y + minY - anchor.minY;
    if (![x, y, p.variant.angle].every(Number.isFinite)) return null;
    layout.push({ blockIndex: index, x, y, angle: p.variant.angle }); seen.add(index);
  }
  return { signature: packingGeometrySignature(blocks, fabricWidth, rotationStep), placements: layout };
}
