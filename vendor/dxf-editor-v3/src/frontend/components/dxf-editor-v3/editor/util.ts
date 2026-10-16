

import ClipperLib from "clipper-lib";
import { type CSSProperties } from "react";
import {
    getDxfLayerSemanticRole,
    getDxfPointRole,
    isPhysicalLayerVisible,
    isTurnCurveMetadataLayer,
    normalizeDxfLayer,
} from "../../../lib/dxf-layer-semantics.ts";
import { mapParserEntityToDxfEntity } from "./mapParserEntityToDxfEntity.ts";
import { BlockVariant, Bounds, DrawableBlock, DrawPathOptions, DxfBlock, DxfEntity, DxfFile, DxfParserModule, InsertTransform, PackedItem, PackedVariant, PackNode, PlacedDrawableBlock, Point, PolylinePath, PolylineTypeHints, PolyPackedItem, PolyProgressiveAttemptOptions, PolyProgressiveOptions, PolyProgressiveResult, PolyVariant, ProgressiveAttemptOptions, ProgressivePackOptions } from "./types.ts";
import { OUTLINE_MARGIN_MM, PACK_HEIGHT_GROWTH, PACK_MAX_ITERATIONS, PACK_PADDING, PAGE_MARGIN, POSITION_EPS } from "./vars.ts";
import type { DxfAnnotation } from "./types.ts";
// Lazy import for browser DXF parsing (dxf-parser). Will be loaded only when needed.
// We avoid static import to keep initial bundle light.


// --- Styles ---
export const inputStyle: CSSProperties = {
    padding: "6px 8px",
    border: "1px solid var(--fp-border)",
    borderRadius: 6,
    background: "var(--fp-card)",
    color: "var(--fp-text)",
};
export const btnStyle: CSSProperties = {
    padding: "6px 10px",
    border: "1px solid var(--fp-border-strong)",
    background: "var(--color-primary)",
    color: "#fff",
    borderRadius: 6,
    cursor: "pointer",
};
export const btnSecondaryStyle: CSSProperties = {
    padding: "6px 10px",
    border: "1px solid var(--fp-border)",
    background: "var(--fp-card)",
    color: "var(--fp-text)",
    borderRadius: 6,
    cursor: "pointer",
};

// --- Data loading ---
export async function fetchDxf(url: string): Promise<DxfFile | null> {
    try {

        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return null;
        const data = (await res.json()) as DxfFile;
        if (!data || typeof data !== "object") return null;
        return data;
    } catch {
        return null;
    }
}

// --- Geometry helpers (ported/simplified from route) ---
export function computeBounds(paths: PolylinePath[]): Bounds | null {
    if (!paths.length) return null;
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const path of paths) {
        for (const p of path.points) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
    return { minX, minY, maxX, maxY };
}

export function normalizeAngle(angle: number) {
    let value = angle % 360;
    if (value < 0) value += 360;
    if (Math.abs(value - 360) < 1e-6 || Math.abs(value) < 1e-6) return 0;
    return value;
}

export function detectHelperBaseSizeFromMarkers(
    blocks: Record<string, DxfBlock>,
    nameMap: Map<string, { sizeLabel?: string | null }>
): string | null {
    if (!blocks) return null;
    const counts = new Map<string, number>();

    Object.entries(blocks).forEach(([name, block]) => {
        const size = nameMap?.get(name)?.sizeLabel?.toLowerCase();
        if (!size) return;
        const paths = extractDrawablePaths(block, { includeHelperLines: true, blocks, blockName: name });
        const markers = paths.filter(
            (path) => path.marker === "point" && isTurnCurveMetadataLayer(path.layer)
        ).length;
        if (markers) counts.set(size, (counts.get(size) ?? 0) + markers);
    });

    const withMarkers = Array.from(counts.entries()).filter(([, count]) => count > 0);
    if (!withMarkers.length) return null;
    if (withMarkers.length === 1) return withMarkers[0][0];
    withMarkers.sort((a, b) => b[1] - a[1]);
    if (withMarkers[0][1] === withMarkers[1][1]) return null;
    return withMarkers[0][0];
}

export function resolveRotationStep(blockStep: number | null | undefined, globalStep: number | null | undefined): number | null {
    if (blockStep === null) return null; // explicit "no rotation" on the piece
    if (blockStep !== undefined) return blockStep;
    return globalStep ?? null;
}

function getManualRotationAngle(block: DrawableBlock): number | null {
    const manual = block.manualAngleOverride;
    if (manual === undefined || manual === null) return null;
    if (!Number.isFinite(manual)) return null;
    return normalizeAngle(manual);
}

export function getRotationAnglesForBlock(block: DrawableBlock, rotationStep: number | null): number[] {
    const manualAngle = getManualRotationAngle(block);
    if (manualAngle !== null) return [manualAngle];
    const stepForBlock = resolveRotationStep(block.rotationStepOverride, rotationStep);
    return createRotationAngles(stepForBlock);
}

export function rotatePaths(paths: PolylinePath[], angleDeg: number, bounds: Bounds): PolylinePath[] {
    const rad = (angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    return paths.map((path) => ({
        ...path,
        points: path.points.map((pt) => {
            const dx = pt.x - cx;
            const dy = pt.y - cy;
            return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
        }),
    }));
}

export function offsetClosedPolylines(paths: PolylinePath[], offsetMm: number, options: { preserveCurveVertices?: boolean } = {}): PolylinePath[] {
    const deltaMm = Number(offsetMm);
    if (!Number.isFinite(deltaMm) || Math.abs(deltaMm) <= 1e-9) return [];

    const simplifyCollinear = (pts: Point[], tolMm: number): Point[] => {
        if (pts.length < 4) return pts;
        const tol2 = tolMm * tolMm;
        const out = pts.slice();

        const distPointToSegment2 = (p: Point, a: Point, b: Point): number => {
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const apx = p.x - a.x;
            const apy = p.y - a.y;
            const ab2 = abx * abx + aby * aby;
            if (ab2 <= 1e-12) {
                return apx * apx + apy * apy;
            }
            let t = (apx * abx + apy * aby) / ab2;
            t = Math.max(0, Math.min(1, t));
            const cx = a.x + t * abx;
            const cy = a.y + t * aby;
            const dx = p.x - cx;
            const dy = p.y - cy;
            return dx * dx + dy * dy;
        };

        // A couple of passes is enough for typical DXF noise.
        for (let pass = 0; pass < 2; pass += 1) {
            if (out.length < 4) break;
            let changed = false;
            // iterate with wrap-around for closed polygon
            for (let i = 0; i < out.length;) {
                if (out.length < 4) break;
                const prev = out[(i - 1 + out.length) % out.length];
                const curr = out[i];
                const next = out[(i + 1) % out.length];
                // Remove point if it's very close to the segment prev->next (nearly collinear)
                if (distPointToSegment2(curr, prev, next) <= tol2) {
                    out.splice(i, 1);
                    changed = true;
                    continue; // re-check same index
                }
                i += 1;
            }
            if (!changed) break;
        }

        return out;
    };

    const closed = paths
        .filter((p) => p.closed && p.points.length >= 3)
        .map((p) => {
            // Clean tiny segments/duplicate points; these can create extreme miter spikes.
            const pts = p.points;
            const cleaned: Point[] = [];
            const EPS2 = 1e-6; // (0.001mm)^2
            for (const pt of pts) {
                const last = cleaned[cleaned.length - 1];
                if (!last) {
                    cleaned.push(pt);
                    continue;
                }
                const dx = pt.x - last.x;
                const dy = pt.y - last.y;
                if (dx * dx + dy * dy <= EPS2) continue;
                cleaned.push(pt);
            }
            // Drop duplicated closing point if present
            if (cleaned.length >= 2) {
                const first = cleaned[0];
                const last = cleaned[cleaned.length - 1];
                const dx = first.x - last.x;
                const dy = first.y - last.y;
                if (dx * dx + dy * dy <= EPS2) cleaned.pop();
            }

            // Remove near-collinear micro-kinks while keeping real corners.
            const simplified = options.preserveCurveVertices ? cleaned : simplifyCollinear(cleaned, 0.02);
            return simplified.length >= 3 ? { ...p, points: simplified } : p;
        })
        .filter((p) => p.closed && p.points.length >= 3);
    if (!closed.length) return [];

    // Clipper works best with integer coordinates; scale mm -> 0.1 micron units.
    // Higher precision reduces visible drift between inset/outset, especially on long edges.
    const SCALE = 10000;
    const toInt = (v: number) => Math.round(v * SCALE);
    const fromInt = (v: number) => v / SCALE;

    const input = closed.map((p) => p.points.map((pt) => ({ X: toInt(pt.x), Y: toInt(pt.y) })));
    const baseArea = closed.reduce((sum, p) => sum + computePathArea(p), 0);

    const perimeterOf = (points: Point[]): number => {
        if (points.length < 2) return 0;
        let total = 0;
        for (let i = 0; i < points.length; i += 1) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            total += Math.hypot(dx, dy);
        }
        return total;
    };

    const basePerimeter = closed.reduce((sum, p) => sum + perimeterOf(p.points), 0);

    const areaSum = (pp: PolylinePath[]): number => {
        const list = (pp ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        if (!list.length) return 0;
        return list.reduce((sum, p) => sum + computePathArea(p), 0);
    };

    const mkOutput = (solution: any[]): PolylinePath[] => {
        const out: PolylinePath[] = [];
        for (const sp of solution || []) {
            if (!sp || sp.length < 3) continue;
            out.push({
                closed: true,
                kind: "outline",
                layer: "__outline_offset",
                points: sp.map((pt: any) => ({ x: fromInt(pt.X), y: fromInt(pt.Y) })),
            });
        }
        return out;
    };

    const execute = (delta: number, joinType: any): PolylinePath[] => {
        const CL: any = (ClipperLib as any)?.default ?? (ClipperLib as any);
        const co = new CL.ClipperOffset(2, 0.25 * SCALE);
        const et = CL.EndType?.etClosedPolygon;
        for (const p of input) {
            co.AddPath(p, joinType, et);
        }
        const solution: any[] = [];
        co.Execute(solution, delta);
        return mkOutput(solution);
    };

    const pickBest = (deltaMm: number): PolylinePath[] => {
        const CL: any = (ClipperLib as any)?.default ?? (ClipperLib as any);
        const jtMiter = CL.JoinType?.jtMiter;
        const jtSquare = CL.JoinType?.jtSquare;
        const jtRound = CL.JoinType?.jtRound;

        // Prefer sharp corners: miter, then square. Round is last-resort.
        const joinCandidates = [jtMiter, jtSquare, jtRound].filter(Boolean);
        const desiredGrow = deltaMm > 0;
        const expectedDelta = Math.max(1e-6, Math.abs(basePerimeter * deltaMm));

        let best: { out: PolylinePath[]; score: number; join: any } | null = null;

        for (const jt of joinCandidates) {
            // Try with given delta.
            let out = execute(deltaMm * SCALE, jt);
            if (!out.length || !(baseArea > 0)) {
                if (out.length && !best) return out;
                continue;
            }

            const outArea = areaSum(out);
            if (!(outArea > 0)) continue;

            const ratio = outArea / baseArea;
            const okDir = desiredGrow ? ratio > 1.0005 : ratio < 0.9995;
            if (!okDir) {
                // Flip sign if orientation causes wrong direction.
                out = execute(-deltaMm * SCALE, jt);
            }

            const outArea2 = areaSum(out);
            if (!(outArea2 > 0)) continue;
            const ratio2 = outArea2 / baseArea;
            const dirOk2 = desiredGrow ? ratio2 > 1.0005 : ratio2 < 0.9995;
            if (!dirOk2) continue;

            const observedDelta = desiredGrow ? outArea2 - baseArea : baseArea - outArea2;
            const relErr = Math.abs(observedDelta - expectedDelta) / expectedDelta;

            // Penalize rounding unless necessary.
            const roundPenalty = jt === jtRound ? 0.5 : 0;
            const score = relErr + roundPenalty;

            if (!best || score < best.score) {
                best = { out, score, join: jt };
            }
        }

        return best?.out ?? [];
    };

    // Clipper offset sign can depend on polygon orientation; validate the expected direction.
    // Use area-based validation (more robust than bounds for concave pieces).
    return pickBest(deltaMm);
}

export function prepareBlocksForWorker(blocks: DrawableBlock[], useRealBounding: boolean, outlineMarginMm: number): { blocks: DrawableBlock[]; outlineMarginForWorker: number } {
    // For AABB packing, we use outlineMarginMm as padding (fast path).
    if (!useRealBounding) {
        return { blocks, outlineMarginForWorker: outlineMarginMm };
    }

    const margin = Math.max(0, Number(outlineMarginMm) || 0);

    const next = blocks.map((b) => {
        // Prefer the layer-1 / seam cutline for polygonal collision when present.
        const seamCandidates = (b.paths ?? []).filter((p) => {
            if (!p) return false;
            const layer = String(p.layer ?? "").trim();
            return (p.kind === "seam" || layer === "1") && Boolean(p.closed) && (p.points?.length ?? 0) >= 3;
        }) as PolylinePath[];

        // buildDrawableBlocks has already selected either layer 1 or the union
        // of layer 1 and layer 14 for variable/zero allowances. Preserve that
        // collision geometry instead of reducing it back to one contour.
        const basePack = b.packPaths?.length
            ? b.packPaths
            : (seamCandidates.length ? seamCandidates : b.paths) ?? [];

        const withMargin = margin > 0 ? offsetClosedPolylines(basePack, margin) : basePack;
        const packPaths = withMargin.length ? withMargin : basePack;
        const bounds = computeBounds(packPaths) ?? b.bounds;

        // Avoid cloning when nothing changes.
        if (packPaths === b.packPaths && bounds === b.bounds) return b;

        return {
            ...b,
            packPaths,
            bounds,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
        } as DrawableBlock;
    });

    // Margin is baked into packPaths when provided; worker should not add extra padding.
    return { blocks: next, outlineMarginForWorker: 0 };
}

export function createBlockVariant(block: DrawableBlock, angle: number): BlockVariant {
    const a = normalizeAngle(angle);
    const packSource = block.packPaths?.length ? block.packPaths : block.paths;
    const renderSource = block.paths;
    const packBase = block.bounds;

    const rotatedPackPaths = Math.abs(a) < 1e-6 ? packSource : rotatePaths(packSource, a, packBase);
    const rotatedRenderPaths = Math.abs(a) < 1e-6 ? renderSource : rotatePaths(renderSource, a, packBase);

    const packBounds = computeBounds(rotatedPackPaths) ?? packBase;

    // Collision bounds for non-real-bounding should follow the visible outer contour
    // (outline/seam), but ignore long helper/construction lines.
    const collisionSource = rotatedRenderPaths.filter((path) => {
        const kind = String((path as any)?.kind ?? "").toLowerCase();
        if (kind === "outline" || kind === "seam") return true;
        return false;
    });
    const renderBoundsCollision = computeBounds(collisionSource.length ? collisionSource : rotatedRenderPaths) ?? packBounds;

    const collisionBounds = {
        minX: Math.min(packBounds.minX, renderBoundsCollision.minX),
        minY: Math.min(packBounds.minY, renderBoundsCollision.minY),
        maxX: Math.max(packBounds.maxX, renderBoundsCollision.maxX),
        maxY: Math.max(packBounds.maxY, renderBoundsCollision.maxY),
    };

    const renderBounds = collisionBounds;

    return {
        block,
        angle: a,
        bounds: collisionBounds,
        renderBounds,
        width: collisionBounds.maxX - collisionBounds.minX,
        height: collisionBounds.maxY - collisionBounds.minY,
        paths: rotatedRenderPaths,
        packPaths: rotatedPackPaths,
    };
}

export function createRotationAngles(step: number | null) {
    if (!step || !Number.isFinite(step) || step <= 0) return [0];
    const normalized = Math.min(Math.abs(step), 180);
    const s = Math.max(normalized, 1);
    const steps = Math.max(Math.floor(360 / s), 1);
    const angles = new Set<number>([0]);
    for (let i = 1; i <= steps; i += 1) {
        const angle = normalizeAngle(i * s);
        if (angle !== 0) angles.add(angle);
    }
    return Array.from(angles).sort((a, b) => a - b);
}


export function findNode(node: PackNode | undefined, width: number, height: number): PackNode | null {
    if (!node) return null;
    if (node.used) return findNode(node.right, width, height) ?? findNode(node.down, width, height);
    if (width <= node.width && height <= node.height) return node;
    return null;
}
export function splitNode(node: PackNode, width: number, height: number): PackNode {
    node.used = true;
    node.down = height < node.height ? { x: node.x, y: node.y + height, width: node.width, height: node.height - height } : undefined;
    node.right = width < node.width ? { x: node.x + width, y: node.y, width: node.width - width, height } : undefined;
    return node;
}

export function preparePackItems(blocks: DrawableBlock[], fabricWidth: number, rotationStep: number | null, outlineMarginMm: number = 0): PackedItem[] {
    const margin = Math.max(0, outlineMarginMm || 0);
    const items = blocks.map((block, idx) => {
        const rotationAngles = getRotationAnglesForBlock(block, rotationStep);
        const variants = rotationAngles
            .map((angle) => createBlockVariant(block, angle))
            .map((variant) => {
                const width = Math.max(variant.width, 1);
                const height = Math.max(variant.height, 1);
                const basePadX = Math.min(PACK_PADDING, Math.max(0, (fabricWidth - width) / 2));
                const padX = basePadX + margin;
                const padY = PACK_PADDING + margin;
                const paddedWidth = width + padX * 2;
                const paddedHeight = height + padY * 2;
                return { variant, width, height, padX, padY, paddedWidth, paddedHeight, paddedArea: paddedWidth * paddedHeight } as PackedVariant;
            })
            .filter((v) => v.paddedWidth <= fabricWidth + 1e-6);
        const maxArea = variants.reduce((m, v) => Math.max(m, v.paddedArea), 0);
        const minArea = variants.reduce((m, v) => Math.min(m, v.paddedArea), Infinity);
        const minHeight = variants.reduce((m, v) => Math.min(m, v.paddedHeight), Infinity);
        const maxWidth = variants.reduce((m, v) => Math.max(m, v.paddedWidth), 0);
        const maxHeight = variants.reduce((m, v) => Math.max(m, v.paddedHeight), 0);
        return { id: idx, block, variants, maxArea, minArea, minHeight, maxWidth, maxHeight } as PackedItem;
    });

    const impossible = items.filter((i) => i.variants.length === 0);
    if (impossible.length) {
        const names = impossible.map((i) => i.block.name).join(", ");
        throw new Error(`Folgende Teile passen nicht in die Stoffbreite: ${names}`);
    }

    return items;
}

export function buildCandidateOrders(items: PackedItem[], randomOrders: number = 8): PackedItem[][] {
    const byArea = items.slice().sort((a, b) => b.maxArea - a.maxArea);
    const byHeight = items.slice().sort((a, b) => b.maxHeight - a.maxHeight);
    const byWidth = items.slice().sort((a, b) => b.maxWidth - a.maxWidth);
    const byRatio = items
        .slice()
        .sort((a, b) => b.maxWidth / Math.max(b.maxHeight, 1) - a.maxWidth / Math.max(a.maxHeight, 1));
    const byMaxSide = items.slice().sort((a, b) => Math.max(b.maxWidth, b.maxHeight) - Math.max(a.maxWidth, a.maxHeight));
    const byMinSide = items.slice().sort((a, b) => Math.min(b.maxWidth, b.maxHeight) - Math.min(a.maxWidth, a.maxHeight));
    const orders: PackedItem[][] = [byArea, byHeight, byWidth, byRatio, byMaxSide, byMinSide];
    for (let i = 0; i < randomOrders; i += 1) {
        const shuffled = items.slice();
        for (let j = shuffled.length - 1; j > 0; j -= 1) {
            const r = Math.floor(Math.random() * (j + 1));
            [shuffled[j], shuffled[r]] = [shuffled[r], shuffled[j]];
        }
        orders.push(shuffled);
    }
    return orders;
}

export function buildCandidateHeights(totalArea: number, fabricWidth: number, maxItemHeight: number): number[] {
    const idealHeight = totalArea / fabricWidth;
    const seeds = [0.6, 0.7, 0.8, 0.9, 1, 1.05, 1.15, 1.3, 1.45];
    const heights = seeds
        .map((factor) => Math.max(maxItemHeight, idealHeight * factor))
        .filter((h) => Number.isFinite(h) && h > 0);
    const unique = Array.from(new Set(heights.map((h) => Math.round(h)))).sort((a, b) => a - b);
    return unique.length ? unique : [Math.max(maxItemHeight, idealHeight || maxItemHeight)];
}

export function packDrawableBlocks(blocks: DrawableBlock[], fabricWidth: number, rotationStep: number | null, opts?: { orderTrials?: number; outlineMarginMm?: number }) {
    if (!fabricWidth || fabricWidth <= 0) throw new Error("Fabric width must be greater than zero for packing.");
    if (!blocks.length) return { placements: [] as PlacedDrawableBlock[], usedHeight: 0 };

    const outlineMarginMm = Math.max(0, opts?.outlineMarginMm ?? 0);
    const items = preparePackItems(blocks, fabricWidth, rotationStep, outlineMarginMm);
    const totalArea = items.reduce((sum, i) => sum + i.minArea, 0);
    const maxItemHeight = items.reduce((m, i) => Math.max(m, i.minHeight), 0);
    const candidateHeights = buildCandidateHeights(totalArea, fabricWidth, maxItemHeight);
    const orders = buildCandidateOrders(items, opts?.orderTrials ?? 10);

    let best: { placements: PlacedDrawableBlock[]; usedHeight: number } | null = null;

    for (const order of orders) {
        for (const h of candidateHeights) {
            const attemptResult = packOrderSync(order, fabricWidth, h, outlineMarginMm);
            if (attemptResult.success) {
                if (isBetterLayout(attemptResult, best, fabricWidth, totalArea)) {
                    best = { placements: attemptResult.placements, usedHeight: attemptResult.usedHeight };
                }
                if (Math.abs(attemptResult.usedHeight - h) < 1 && fabricWidth * attemptResult.usedHeight - totalArea <= 1) {
                    return { placements: attemptResult.placements, usedHeight: attemptResult.usedHeight };
                }
            }
        }
    }

    // Fallback to growth strategy if no candidate height worked perfectly
    let height = Math.max(maxItemHeight, candidateHeights[candidateHeights.length - 1] || maxItemHeight);
    const sorted = items.slice().sort((a, b) => b.maxArea - a.maxArea);
    for (let attempt = 0; attempt < PACK_MAX_ITERATIONS; attempt += 1) {
        const result = packOrderSync(sorted, fabricWidth, height, outlineMarginMm);
        if (result.success) {
            if (isBetterLayout(result, best, fabricWidth, totalArea)) {
                best = { placements: result.placements, usedHeight: result.usedHeight };
            }
            if (best) return best;
        }
        height *= PACK_HEIGHT_GROWTH;
    }

    if (best) return best;

    throw new Error("Failed to arrange cut parts without overlap. Increase fabric width or adjust rotation.");
}


export function pointInPoly(pt: Point, poly: Point[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x,
            yi = poly[i].y;
        const xj = poly[j].x,
            yj = poly[j].y;
        const intersect = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-9) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function clipOpenPathToClosedPolygon(path: PolylinePath, polygonRaw: Point[]): PolylinePath[] {
    if (path.closed || path.marker === "point" || (path.points?.length ?? 0) < 2) return [path];
    const polygon = polygonRaw.length > 1 && arePointsEqual(polygonRaw[0], polygonRaw[polygonRaw.length - 1])
        ? polygonRaw.slice(0, -1)
        : polygonRaw.slice();
    if (polygon.length < 3) return [path];

    const lerp = (a: Point, b: Point, t: number): Point => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    });
    const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
    const samePoint = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= 1e-5;
    const pieces: PolylinePath[] = [];
    let active: Point[] | null = null;

    for (let segmentIndex = 0; segmentIndex < path.points.length - 1; segmentIndex += 1) {
        const a = path.points[segmentIndex];
        const b = path.points[segmentIndex + 1];
        const rx = b.x - a.x;
        const ry = b.y - a.y;
        const cuts = [0, 1];

        for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex += 1) {
            const c = polygon[edgeIndex];
            const d = polygon[(edgeIndex + 1) % polygon.length];
            const sx = d.x - c.x;
            const sy = d.y - c.y;
            const denominator = cross(rx, ry, sx, sy);
            if (Math.abs(denominator) <= 1e-10) continue;
            const qpx = c.x - a.x;
            const qpy = c.y - a.y;
            const t = cross(qpx, qpy, sx, sy) / denominator;
            const u = cross(qpx, qpy, rx, ry) / denominator;
            if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-9 && u <= 1 + 1e-9) cuts.push(t);
        }

        cuts.sort((x, y) => x - y);
        const uniqueCuts = cuts.filter((value, index) => index === 0 || Math.abs(value - cuts[index - 1]) > 1e-8);
        for (let i = 0; i < uniqueCuts.length - 1; i += 1) {
            const t0 = uniqueCuts[i];
            const t1 = uniqueCuts[i + 1];
            if (t1 - t0 <= 1e-9) continue;
            const midpoint = lerp(a, b, (t0 + t1) / 2);
            if (!pointInPoly(midpoint, polygon)) {
                if (active && active.length >= 2) pieces.push({ ...path, points: active, closed: false });
                active = null;
                continue;
            }
            const start = lerp(a, b, t0);
            const end = lerp(a, b, t1);
            if (!active || !samePoint(active[active.length - 1], start)) {
                if (active && active.length >= 2) pieces.push({ ...path, points: active, closed: false });
                active = [start, end];
            } else if (!samePoint(active[active.length - 1], end)) {
                active.push(end);
            }
        }
    }

    if (active && active.length >= 2) pieces.push({ ...path, points: active, closed: false });
    return pieces;
}

/**
 * Layer 7 represents the fabric-flow/grain direction, not an arbitrary
 * construction segment. Keep its midpoint and length while making the local
 * piece-space direction exactly vertical.
 */
function normalizeFabricDirectionPath(path: PolylinePath): PolylinePath {
    if (
        normalizeDxfLayer(path.layer) !== "7" ||
        path.closed ||
        path.marker === "point" ||
        path.points.length < 2
    ) {
        return path;
    }

    const first = path.points[0];
    const last = path.points[path.points.length - 1];
    const length = Math.hypot(last.x - first.x, last.y - first.y);
    if (!Number.isFinite(length) || length <= 1e-6) return path;

    const centerX = (first.x + last.x) / 2;
    const centerY = (first.y + last.y) / 2;
    const direction = last.y < first.y ? -1 : 1;
    const startY = centerY - direction * length / 2;
    const endY = centerY + direction * length / 2;
    const pointCount = path.points.length;

    return {
        ...path,
        points: path.points.map((_, index) => {
            const t = index / (pointCount - 1);
            return {
                x: centerX,
                y: startY + (endY - startY) * t,
            };
        }),
    };
}

export function rasterizeOutline(paths: PolylinePath[], bounds: Bounds, cell: number, outlineMarginMm: number = 0): { mask: boolean[][]; w: number; h: number } {
    const m = Math.max(0, outlineMarginMm || 0);
    const b =
        m > 0
            ? { minX: bounds.minX - m, minY: bounds.minY - m, maxX: bounds.maxX + m, maxY: bounds.maxY + m }
            : bounds;
    const width = Math.max(b.maxX - b.minX, 1);
    const height = Math.max(b.maxY - b.minY, 1);
    const w = Math.max(1, Math.ceil(width / cell));
    const h = Math.max(1, Math.ceil(height / cell));
    const mask: boolean[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
    const outlines = paths.filter((p) => p.closed && p.points.length >= 3);
    if (!outlines.length) return { mask, w, h };

    for (let iy = 0; iy < h; iy += 1) {
        for (let ix = 0; ix < w; ix += 1) {
            const cx = b.minX + (ix + 0.5) * cell;
            const cy = b.minY + (iy + 0.5) * cell;
            for (const poly of outlines) {
                if (pointInPoly({ x: cx, y: cy }, poly.points)) {
                    mask[iy][ix] = true;
                    break;
                }
            }
        }
    }

    // A center-point fill alone is not conservative: two curved boundaries can
    // cross inside one grid cell while both cell centers remain outside. The
    // packer then accepts a placement whose rendered contours visibly overlap.
    //
    // Mark every grid cell traversed by each polygon edge as occupied as well.
    // The supercover traversal also marks both adjacent cells at an exact grid
    // corner, preventing diagonal corner-cutting without changing DXF geometry.
    const markCell = (x: number, y: number) => {
        if (x >= 0 && x < w && y >= 0 && y < h) mask[y][x] = true;
    };
    const markSegmentCells = (a: Point, z: Point) => {
        const x0 = (a.x - b.minX) / cell;
        const y0 = (a.y - b.minY) / cell;
        const x1 = (z.x - b.minX) / cell;
        const y1 = (z.y - b.minY) / cell;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
        const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
        let ix = Math.max(0, Math.min(w - 1, Math.floor(x0)));
        let iy = Math.max(0, Math.min(h - 1, Math.floor(y0)));
        const endX = Math.max(0, Math.min(w - 1, Math.floor(x1)));
        const endY = Math.max(0, Math.min(h - 1, Math.floor(y1)));
        const tDeltaX = stepX === 0 ? Infinity : 1 / Math.abs(dx);
        const tDeltaY = stepY === 0 ? Infinity : 1 / Math.abs(dy);
        let tMaxX = stepX > 0
            ? (Math.floor(x0) + 1 - x0) * tDeltaX
            : stepX < 0
                ? (x0 - Math.floor(x0)) * tDeltaX
                : Infinity;
        let tMaxY = stepY > 0
            ? (Math.floor(y0) + 1 - y0) * tDeltaY
            : stepY < 0
                ? (y0 - Math.floor(y0)) * tDeltaY
                : Infinity;

        markCell(ix, iy);
        const maxSteps = w + h + 4;
        for (let steps = 0; (ix !== endX || iy !== endY) && steps < maxSteps; steps += 1) {
            if (Math.abs(tMaxX - tMaxY) <= 1e-12) {
                markCell(ix + stepX, iy);
                markCell(ix, iy + stepY);
                ix += stepX;
                iy += stepY;
                tMaxX += tDeltaX;
                tMaxY += tDeltaY;
            } else if (tMaxX < tMaxY) {
                ix += stepX;
                tMaxX += tDeltaX;
            } else {
                iy += stepY;
                tMaxY += tDeltaY;
            }
            markCell(ix, iy);
        }
    };
    for (const polygon of outlines) {
        for (let index = 0; index < polygon.points.length; index += 1) {
            markSegmentCells(
                polygon.points[index],
                polygon.points[(index + 1) % polygon.points.length]
            );
        }
    }
    return { mask, w, h };
}

function booleanMaskToBitRows(mask: boolean[][], width: number): Uint32Array[] {
    const words = Math.max(1, Math.ceil(width / 32));
    return mask.map((row) => {
        const bits = new Uint32Array(words);
        for (let x = 0; x < Math.min(width, row.length); x += 1) {
            if (row[x]) bits[x >>> 5] |= (1 << (x & 31)) >>> 0;
        }
        return bits;
    });
}

export function buildPolyVariants(block: DrawableBlock, rotationStep: number | null, cell: number, outlineMarginMm: number = 0): PolyVariant[] {
    const rotationAngles = getRotationAnglesForBlock(block, rotationStep);
    const packSource = block.packPaths?.length ? block.packPaths : block.paths;
    const margin = Math.max(0, Number(outlineMarginMm) || 0);

    return rotationAngles
        .map((angle) => {
            const variant = createBlockVariant(block, angle);
            const rotatedPackPaths = Math.abs(angle) < 1e-6 ? packSource : rotatePaths(packSource, angle, block.bounds);
            const offsetPackPaths = margin > 0 ? offsetClosedPolylines(rotatedPackPaths, margin) : rotatedPackPaths;
            const collisionPaths = offsetPackPaths.length ? offsetPackPaths : rotatedPackPaths;
            const bounds = computeBounds(collisionPaths) ?? variant.bounds;
            const width = bounds.maxX - bounds.minX;
            const height = bounds.maxY - bounds.minY;
            const { mask, w, h } = rasterizeOutline(collisionPaths, bounds, cell, 0);
            return {
                variant: {
                    ...variant,
                    bounds,
                    renderBounds: bounds,
                    width,
                    height,
                    packPaths: collisionPaths,
                },
                mask,
                bitRows: booleanMaskToBitRows(mask, w),
                maskW: w,
                maskH: h,
                cell,
            } as PolyVariant;
        })
        .filter((v) => v.maskW > 0 && v.maskH > 0);
}

function polyVariantFitsFabric(variant: PolyVariant, fabricWidth: number): boolean {
    return variant.variant.width <= fabricWidth + POSITION_EPS;
}

function polyVariantFitsAtX(variant: PolyVariant, cellX: number, fabricWidth: number): boolean {
    const left = cellX * variant.cell;
    return left >= -POSITION_EPS && left + variant.variant.width <= fabricWidth + POSITION_EPS;
}

function polyMaskFits(
    occupancy: Uint32Array[],
    variant: PolyVariant,
    cellX: number,
    cellY: number
): boolean {
    const sourceRows = variant.bitRows ?? booleanMaskToBitRows(variant.mask, variant.maskW);
    const wordOffset = cellX >>> 5;
    const bitOffset = cellX & 31;

    for (let y = 0; y < variant.maskH; y += 1) {
        const target = occupancy[cellY + y];
        const source = sourceRows[y];
        for (let word = 0; word < source.length; word += 1) {
            const value = source[word] >>> 0;
            if (!value) continue;
            const targetWord = wordOffset + word;
            if (((value << bitOffset) >>> 0) & (target[targetWord] >>> 0)) return false;
            if (
                bitOffset > 0 &&
                targetWord + 1 < target.length &&
                (value >>> (32 - bitOffset)) & (target[targetWord + 1] >>> 0)
            ) {
                return false;
            }
        }
    }
    return true;
}

function placePolyMask(
    occupancy: Uint32Array[],
    variant: PolyVariant,
    cellX: number,
    cellY: number
) {
    const sourceRows = variant.bitRows ?? booleanMaskToBitRows(variant.mask, variant.maskW);
    const wordOffset = cellX >>> 5;
    const bitOffset = cellX & 31;

    for (let y = 0; y < variant.maskH; y += 1) {
        const target = occupancy[cellY + y];
        const source = sourceRows[y];
        for (let word = 0; word < source.length; word += 1) {
            const value = source[word] >>> 0;
            if (!value) continue;
            const targetWord = wordOffset + word;
            target[targetWord] = (target[targetWord] | ((value << bitOffset) >>> 0)) >>> 0;
            if (bitOffset > 0 && targetWord + 1 < target.length) {
                target[targetWord + 1] = (target[targetWord + 1] | (value >>> (32 - bitOffset))) >>> 0;
            }
        }
    }
}

export function packDrawableBlocksPoly(
    blocks: DrawableBlock[],
    fabricWidth: number,
    rotationStep: number | null,
    opts?: {
        orderTrials?: number;
        grid?: number;
        outlineMarginMm?: number;
        randomizeFirstOrder?: boolean;
        vectorGuard?: boolean;
        compactionPasses?: number;
    }
) {
    const outlineMarginMm = Math.max(0, opts?.outlineMarginMm ?? 0);

    const cell = Math.max(2, Math.min(20, opts?.grid ?? 5));
    const fabricCells = Math.max(1, Math.ceil(fabricWidth / cell));

    const items: PolyPackedItem[] = blocks.map((block) => {
        const variants = buildPolyVariants(block, rotationStep, cell, outlineMarginMm)
            .filter((variant) => variant.maskW <= fabricCells && polyVariantFitsFabric(variant, fabricWidth));
        return { block, variants, area: computeBlockOutlineArea(block) };
    });

    const impossible = items.filter((i) => i.variants.length === 0);
    if (impossible.length) {
        const names = impossible.map((i) => i.block.name).join(", ");
        throw new Error(`Folgende Teile passen nicht in die Stoffbreite: ${names}`);
    }

    const orders: PolyPackedItem[][] = [];
    const byArea = items.slice().sort((a, b) => b.area - a.area);
    const orderTrials = Math.max(1, opts?.orderTrials ?? 1);
    if (!opts?.randomizeFirstOrder) orders.push(byArea);
    const randomOrderCount = opts?.randomizeFirstOrder ? orderTrials : orderTrials - 1;
    for (let i = 0; i < randomOrderCount; i += 1) {
        const shuffled = items.slice();
        for (let j = shuffled.length - 1; j > 0; j -= 1) {
            const r = Math.floor(Math.random() * (j + 1));
            [shuffled[j], shuffled[r]] = [shuffled[r], shuffled[j]];
        }
        orders.push(shuffled);
    }

    let best: { placements: PlacedDrawableBlock[]; usedHeight: number } | null = null;

    for (const order of orders) {
        const packed = packPolyOrder(order, fabricCells, cell, outlineMarginMm, fabricWidth);
        const result = packed && opts?.vectorGuard !== false
            ? compactPlacementsVector(packed.placements, fabricWidth, {
                passes: opts?.compactionPasses,
            })
            : packed;
        if (result && (!best || result.usedHeight < best.usedHeight - POSITION_EPS)) {
            best = result;
        }
    }

    if (!best) throw new Error("Keine polygonale Platzierung möglich");
    return best;
}

export function packPolyOrder(
    order: PolyPackedItem[],
    fabricCells: number,
    cell: number,
    _outlineMarginMm: number,
    fabricWidth: number = fabricCells * cell
) {
    const occupancyWords = Math.max(1, Math.ceil(fabricCells / 32));
    const occ: Uint32Array[] = [];
    let occupiedHeightCells = 0;
    const placements: PlacedDrawableBlock[] = [];

    const ensureHeight = (h: number) => {
        while (occ.length < h) {
            occ.push(new Uint32Array(occupancyWords));
        }
    };

    for (const item of order) {
        let bestChoice: { variant: PolyVariant; x: number; y: number; top: number } | null = null;
        const variants = item.variants.slice().sort((a, b) => a.maskH - b.maskH || b.maskW - a.maskW);

        for (const variant of variants) {
            // Search through the first completely empty row. That guarantees a
            // finite candidate for every permitted rotation, so rotation choice
            // is based on resulting height instead of array order.
            ensureHeight(occupiedHeightCells + variant.maskH);
            let foundForVariant = false;
            for (let y = 0; y <= occupiedHeightCells && !foundForVariant; y += 1) {
                for (let x = 0; x <= fabricCells - variant.maskW; x += 1) {
                    if (!polyVariantFitsAtX(variant, x, fabricWidth) || !polyMaskFits(occ, variant, x, y)) continue;
                    const top = Math.max(occupiedHeightCells, y + variant.maskH);
                    const current = bestChoice;
                    const isBetter =
                        !current ||
                        top < current.top ||
                        (top === current.top && y < current.y) ||
                        (top === current.top && y === current.y && variant.maskH < current.variant.maskH) ||
                        (top === current.top && y === current.y && variant.maskH === current.variant.maskH && variant.maskW > current.variant.maskW) ||
                        (top === current.top && y === current.y && variant.maskH === current.variant.maskH && variant.maskW === current.variant.maskW && x < current.x);
                    if (isBetter) bestChoice = { variant, x, y, top };
                    foundForVariant = true;
                    break;
                }
            }
        }
        if (!bestChoice) return null;

        const { variant, x, y, top } = bestChoice;
        placePolyMask(occ, variant, x, y);
        placements.push({
            block: item.block,
            variant: variant.variant,
            x: x * cell,
            y: y * cell,
            width: variant.variant.width,
            height: variant.variant.height,
        });
        occupiedHeightCells = top;
    }

    // Use the actual transformed geometry height; raster cells can overestimate it.
    const usedHeight = usedHeightFromPlacements(placements);
    return { placements, usedHeight };
}


export async function progressivePackDrawableBlocksPoly(
    blocks: DrawableBlock[],
    fabricWidth: number,
    rotationStep: number | null,
    options?: PolyProgressiveOptions
): Promise<{ placements: PlacedDrawableBlock[]; usedHeight: number } | null> {
    if (!fabricWidth || fabricWidth <= 0) throw new Error("Fabric width must be greater than zero for packing.");
    if (!blocks.length) return { placements: [], usedHeight: 0 };

    const outlineMarginMm = Math.max(0, options?.outlineMarginMm ?? 0);

    const cell = Math.max(2, Math.min(20, options?.grid ?? 5));
    const fabricCells = Math.max(1, Math.ceil(fabricWidth / cell));

    const items: PolyPackedItem[] = blocks.map((block) => {
        const variants = buildPolyVariants(block, rotationStep, cell, outlineMarginMm)
            .filter((variant) => variant.maskW <= fabricCells && polyVariantFitsFabric(variant, fabricWidth));
        return { block, variants, area: computeBlockOutlineArea(block) };
    });

    const impossible = items.filter((i) => i.variants.length === 0);
    if (impossible.length) {
        const names = impossible.map((i) => i.block.name).join(", ");
        throw new Error(`Folgende Teile passen nicht in die Stoffbreite: ${names}`);
    }

    const orders: PolyPackedItem[][] = [];
    if (options?.resolveOrderUnit) {
        const described = describePolyOrderSpace(items);
        const unit = await options.resolveOrderUnit({
            totalUnits: described.totalUnits.toString(),
            orderSpaceKey: described.orderSpaceKey,
            pieceCount: items.length,
            equivalentPieceGroups: described.groupSizes,
        });
        orders.push(
            unrankPolyOrder(
                items,
                described.keys,
                unit,
                described.totalUnits,
                described.orderSpaceKey
            )
        );
    } else {
        const byArea = items.slice().sort((a, b) => b.area - a.area);
        const orderTrials = Math.max(1, options?.maxRandomOrders ?? 1);
        if (!options?.randomizeFirstOrder) orders.push(byArea);
        const randomOrderCount = options?.randomizeFirstOrder ? orderTrials : orderTrials - 1;
        for (let i = 0; i < randomOrderCount; i += 1) {
            const shuffled = items.slice();
            for (let j = shuffled.length - 1; j > 0; j -= 1) {
                const r = Math.floor(Math.random() * (j + 1));
                [shuffled[j], shuffled[r]] = [shuffled[r], shuffled[j]];
            }
            orders.push(shuffled);
        }
    }

    let best: { placements: PlacedDrawableBlock[]; usedHeight: number } | null = null;

    for (let idx = 0; idx < orders.length; idx += 1) {
        if (options?.shouldStop?.()) return null;
        const attemptResult = await packPolyOrderProgressive(orders[idx], fabricCells, cell, outlineMarginMm, {
            ...options,
            attempt: idx + 1,
            totalAttempts: orders.length,
            totalPieces: blocks.length,
            bestHeight: best?.usedHeight,
            fabricWidth,
        });
        if (attemptResult.stopped) return null;
        if (attemptResult.pruned) {
            await yieldToBrowser();
            continue;
        }
        const packed = attemptResult.result;
        const result = packed && options?.vectorGuard !== false
            ? compactPlacementsVector(packed.placements, fabricWidth, {
                passes: options?.compactionPasses,
                shouldStop: options?.shouldStop,
            })
            : packed;
        if (result) {
            if (!best || result.usedHeight < best.usedHeight - POSITION_EPS) {
                best = result;
            }
            options?.onPlacement?.({
                placements: clonePlacements(result.placements),
                usedHeight: result.usedHeight,
                placed: blocks.length,
                total: blocks.length,
                attempt: idx + 1,
                totalAttempts: orders.length,
                bestHeight: best?.usedHeight,
            });
            options?.onAttemptResult?.({
                placements: clonePlacements(result.placements),
                usedHeight: result.usedHeight,
                attempt: idx + 1,
                totalAttempts: orders.length,
                waste: computeWaste(result.placements, fabricWidth),
            });
        }
        await yieldToBrowser();
    }

    return best;
}

const factorialBigInt = (value: number) => {
    let result = BigInt(1);
    for (let index = 2; index <= Math.max(0, Math.floor(value)); index += 1) {
        result *= BigInt(index);
    }
    return result;
};

const hashOrderText = (value: string) => {
    let first = 2166136261;
    let second = 2246822519;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second ^ code, 3266489917);
    }
    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const hashOrderBigInt = (value: string) => {
    let hash = BigInt("14695981039346656037");
    const prime = BigInt("1099511628211");
    const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
    for (let index = 0; index < value.length; index += 1) {
        hash = ((hash ^ BigInt(value.charCodeAt(index))) * prime) & mask;
    }
    return hash;
};

const hashOrderWide = (value: string, modulus: bigint) => {
    if (modulus <= BigInt(1)) return BigInt(0);
    const requiredChunks = Math.max(
        1,
        Math.ceil(modulus.toString(2).length / 64)
    );
    let wide = BigInt(0);
    for (let chunk = 0; chunk < requiredChunks; chunk += 1) {
        wide =
            (wide << BigInt(64)) |
            hashOrderBigInt(`${value}:chunk:${chunk}`);
    }
    return wide % modulus;
};

const greatestCommonDivisorBigInt = (left: bigint, right: bigint) => {
    let a = left < BigInt(0) ? -left : left;
    let b = right < BigInt(0) ? -right : right;
    while (b !== BigInt(0)) {
        const remainder = a % b;
        a = b;
        b = remainder;
    }
    return a;
};

/**
 * Maps sequential distributed-work units onto distant permutation ranks.
 * The affine multiplier is coprime with the space size, so this is a
 * deterministic bijection: every order is visited exactly once.
 */
export const scramblePolyOrderUnit = (
    unitRaw: string,
    totalUnits: bigint,
    orderSpaceKey: string
) => {
    if (totalUnits <= BigInt(1)) return BigInt(0);
    let step = hashOrderWide(`${orderSpaceKey}:step`, totalUnits);
    if (step === BigInt(0)) step = BigInt(1);
    while (greatestCommonDivisorBigInt(step, totalUnits) !== BigInt(1)) {
        step = (step + BigInt(1)) % totalUnits;
        if (step === BigInt(0)) step = BigInt(1);
    }
    const offset = hashOrderWide(`${orderSpaceKey}:offset`, totalUnits);
    let unit = BigInt(String(unitRaw || "0"));
    unit %= totalUnits;
    if (unit < BigInt(0)) unit += totalUnits;
    return (unit * step + offset) % totalUnits;
};

const polyItemEquivalenceKey = (item: PolyPackedItem) => {
    const variants = item.variants
        .map((variant) => {
            let maskHash = 2166136261;
            for (const row of variant.mask) {
                for (const occupied of row) {
                    maskHash = Math.imul(maskHash ^ (occupied ? 1 : 0), 16777619);
                }
            }
            return [
                Math.round(Number(variant.variant?.angle || 0) * 1000),
                variant.maskW,
                variant.maskH,
                Math.round(Number(variant.variant?.width || 0) * 1000),
                Math.round(Number(variant.variant?.height || 0) * 1000),
                (maskHash >>> 0).toString(36),
            ].join(":");
        })
        .sort()
        .join(",");
    return hashOrderText(
        [
            String(item.block?.pieceLabel || item.block?.name || "").trim().toLowerCase(),
            String((item.block as any)?.polyType || ""),
            Math.round(Number(item.area || 0) * 1000),
            variants,
        ].join("|")
    );
};

const permutationsForCounts = (counts: number[]) => {
    const total = counts.reduce((sum, count) => sum + count, 0);
    return counts.reduce(
        (value, count) => value / factorialBigInt(count),
        factorialBigInt(total)
    );
};

const describePolyOrderSpace = (items: PolyPackedItem[]) => {
    const keys = items.map(polyItemEquivalenceKey);
    const counts = new Map<string, number>();
    keys.forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
    const groupSizes = Array.from(counts.values()).sort((a, b) => b - a);
    const totalUnits = permutationsForCounts(groupSizes);
    const orderSpaceKey = hashOrderText(
        Array.from(counts.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, count]) => `${key}:${count}`)
            .join("|")
    );
    return { keys, groupSizes, totalUnits, orderSpaceKey };
};

const unrankPolyOrder = (
    items: PolyPackedItem[],
    itemKeys: string[],
    unitRaw: string,
    totalUnits: bigint,
    orderSpaceKey: string
) => {
    const queues = new Map<string, PolyPackedItem[]>();
    items.forEach((item, index) => {
        const key = itemKeys[index];
        queues.set(key, [...(queues.get(key) || []), item]);
    });
    const counts = new Map(
        Array.from(queues.entries()).map(([key, values]) => [key, values.length])
    );
    const sortedKeys = Array.from(counts.keys()).sort();
    let unit = scramblePolyOrderUnit(unitRaw, totalUnits, orderSpaceKey);
    const order: PolyPackedItem[] = [];

    while (order.length < items.length) {
        let selected = "";
        for (const key of sortedKeys) {
            const count = counts.get(key) || 0;
            if (!count) continue;
            counts.set(key, count - 1);
            const possibilities = permutationsForCounts(Array.from(counts.values()));
            if (unit < possibilities) {
                selected = key;
                break;
            }
            unit -= possibilities;
            counts.set(key, count);
        }
        if (!selected) throw new Error("Could not resolve deterministic packing order");
        const queue = queues.get(selected) || [];
        const item = queue.shift();
        if (!item) throw new Error("Deterministic packing order references a missing piece");
        order.push(item);
    }
    return order;
};

export async function packPolyOrderProgressive(
    order: PolyPackedItem[],
    fabricCells: number,
    cell: number,
    _outlineMarginMm: number,
    options: PolyProgressiveAttemptOptions
): Promise<PolyProgressiveResult> {
    const occupancyWords = Math.max(1, Math.ceil(fabricCells / 32));
    const occ: Uint32Array[] = [];
    let occupiedHeightCells = 0;
    const placements: PlacedDrawableBlock[] = [];
    let usedHeightNow = 0;
    let iterations = 0;
    let backendFailureReason = "";

    if (options.rasterBackend) {
        const startedAt = performance.now();
        try {
            const accelerated = await options.rasterBackend({
                order,
                fabricCells,
                fabricWidth: options.fabricWidth,
                cell,
            });
            if (accelerated) {
                if (accelerated.choices.length !== order.length) {
                    throw new Error("Accelerated packer returned an invalid placement count");
                }
                for (let index = 0; index < order.length; index += 1) {
                    if (options.shouldStop?.()) {
                        return { result: null, stopped: true, pruned: false };
                    }
                    const item = order[index];
                    const variants = item.variants
                        .slice()
                        .sort((a, b) => a.maskH - b.maskH || b.maskW - a.maskW);
                    const choice = accelerated.choices[index];
                    const variant = variants[choice.variantIndex];
                    if (
                        !variant ||
                        !Number.isInteger(choice.x) ||
                        !Number.isInteger(choice.y) ||
                        choice.x < 0 ||
                        choice.y < 0
                    ) {
                        throw new Error("Accelerated packer returned an invalid placement");
                    }
                    const candidate = {
                        block: item.block,
                        variant: variant.variant,
                        x: choice.x * cell,
                        y: choice.y * cell,
                        width: variant.variant.width,
                        height: variant.variant.height,
                    };
                    placements.push(candidate);
                    usedHeightNow = Math.max(usedHeightNow, candidate.y + candidate.height);
                    const maxUsedHeightExclusive = Number(options.maxUsedHeightExclusive);
                    if (
                        options.vectorGuard === false &&
                        Number.isFinite(maxUsedHeightExclusive) &&
                        maxUsedHeightExclusive > 0 &&
                        usedHeightNow >= maxUsedHeightExclusive - POSITION_EPS
                    ) {
                        options.onBackend?.({
                            backend: accelerated.backend,
                            durationMs: accelerated.durationMs,
                        });
                        options.onPruned?.({
                            usedHeight: usedHeightNow,
                            maxUsedHeightExclusive,
                            placed: placements.length,
                            total: options.totalPieces,
                            attempt: options.attempt,
                            totalAttempts: options.totalAttempts,
                        });
                        return { result: null, stopped: false, pruned: true };
                    }
                    options.onPlacement?.({
                        placements: clonePlacements(placements),
                        usedHeight: usedHeightNow,
                        placed: placements.length,
                        total: options.totalPieces,
                        attempt: options.attempt,
                        totalAttempts: options.totalAttempts,
                        bestHeight: options.bestHeight,
                    });
                }
                options.onBackend?.({
                    backend: accelerated.backend,
                    durationMs: accelerated.durationMs,
                });
                return {
                    result: {
                        placements,
                        usedHeight: usedHeightFromPlacements(placements),
                    },
                    stopped: false,
                    pruned: false,
                };
            }
            backendFailureReason = "Accelerated backend was unavailable";
        } catch (error: any) {
            backendFailureReason = error?.message || String(error);
            console.warn(
                "Accelerated raster packing failed; continuing in JavaScript",
                error
            );
        }
        // Include initialization/IPC time in the fallback reason, while timing
        // the JavaScript work separately below.
        const failedAfterMs = performance.now() - startedAt;
        backendFailureReason = `${backendFailureReason} (${failedAfterMs.toFixed(1)} ms)`;
    }

    const javascriptStartedAt = performance.now();

    const ensureHeight = (h: number) => {
        while (occ.length < h) {
            occ.push(new Uint32Array(occupancyWords));
        }
    };

    for (const item of order) {
        if (options.shouldStop?.()) return { result: null, stopped: true, pruned: false };
        let bestChoice: { variant: PolyVariant; x: number; y: number; top: number } | null = null;
        const variants = item.variants.slice().sort((a, b) => a.maskH - b.maskH || b.maskW - a.maskW);

        for (const variant of variants) {
            ensureHeight(occupiedHeightCells + variant.maskH);
            let foundForVariant = false;
            for (let y = 0; y <= occupiedHeightCells && !foundForVariant; y += 1) {
                if (options.shouldStop?.()) return { result: null, stopped: true, pruned: false };
                for (let x = 0; x <= fabricCells - variant.maskW; x += 1) {
                    if (
                        polyVariantFitsAtX(variant, x, options.fabricWidth) &&
                        polyMaskFits(occ, variant, x, y)
                    ) {
                        const top = Math.max(occupiedHeightCells, y + variant.maskH);
                        const current = bestChoice;
                        const isBetter =
                            !current ||
                            top < current.top ||
                            (top === current.top && y < current.y) ||
                            (top === current.top && y === current.y && variant.maskH < current.variant.maskH) ||
                            (top === current.top && y === current.y && variant.maskH === current.variant.maskH && variant.maskW > current.variant.maskW) ||
                            (top === current.top && y === current.y && variant.maskH === current.variant.maskH && variant.maskW === current.variant.maskW && x < current.x);
                        if (isBetter) bestChoice = { variant, x, y, top };
                        foundForVariant = true;
                    }
                    iterations += 1;
                    if (iterations % 200 === 0) {
                        await yieldToBrowser();
                        if (options.shouldStop?.()) return { result: null, stopped: true, pruned: false };
                    }
                    if (foundForVariant) break;
                }
            }
        }
        if (!bestChoice) {
            options.onBackend?.({
                backend: "javascript",
                durationMs: performance.now() - javascriptStartedAt,
                reason: backendFailureReason || undefined,
            });
            return { result: null, stopped: false, pruned: false };
        }

        const { variant, x, y, top } = bestChoice;
        placePolyMask(occ, variant, x, y);
        const candidate = {
            block: item.block,
            variant: variant.variant,
            x: x * cell,
            y: y * cell,
            width: variant.variant.width,
            height: variant.variant.height,
        };
        placements.push(candidate);
        occupiedHeightCells = top;
        usedHeightNow = Math.max(usedHeightNow, candidate.y + candidate.height);
        const usedHeight = usedHeightNow;
        const maxUsedHeightExclusive = Number(options.maxUsedHeightExclusive);
        if (
            options.vectorGuard === false &&
            Number.isFinite(maxUsedHeightExclusive) &&
            maxUsedHeightExclusive > 0 &&
            usedHeight >= maxUsedHeightExclusive - POSITION_EPS
        ) {
            options.onPruned?.({
                usedHeight,
                maxUsedHeightExclusive,
                placed: placements.length,
                total: options.totalPieces,
                attempt: options.attempt,
                totalAttempts: options.totalAttempts,
            });
            options.onBackend?.({
                backend: "javascript",
                durationMs: performance.now() - javascriptStartedAt,
                reason: backendFailureReason || undefined,
            });
            return { result: null, stopped: false, pruned: true };
        }
        if (options.onPlacement) {
            options.onPlacement({
                placements: clonePlacements(placements),
                usedHeight,
                placed: placements.length,
                total: options.totalPieces,
                attempt: options.attempt,
                totalAttempts: options.totalAttempts,
                bestHeight: options.bestHeight,
            });
        }
    }

    const usedHeight = usedHeightFromPlacements(placements);
    options.onBackend?.({
        backend: "javascript",
        durationMs: performance.now() - javascriptStartedAt,
        reason: backendFailureReason || undefined,
    });
    return { result: { placements, usedHeight }, stopped: false, pruned: false };
}

export function packOrderSync(
    order: PackedItem[],
    fabricWidth: number,
    height: number,
    outlineMarginMm: number = 0
): { success: boolean; placements: PlacedDrawableBlock[]; usedHeight: number } {
    const placements: PlacedDrawableBlock[] = [];
    const root: PackNode = { x: 0, y: 0, width: fabricWidth, height };

    for (const item of order) {
        let placed = false;
        const candidates = item.variants
            .slice()
            .sort((a, b) => {
                const wa = Math.min(a.paddedWidth, fabricWidth) / fabricWidth;
                const wb = Math.min(b.paddedWidth, fabricWidth) / fabricWidth;
                if (wb !== wa) return wb - wa;
                return a.paddedHeight - b.paddedHeight;
            });

        for (const c of candidates) {
            if (c.paddedWidth > fabricWidth + 1e-6) continue;
            const node = findNode(root, c.paddedWidth, c.paddedHeight);
            if (node) {
                const s = splitNode(node, c.paddedWidth, c.paddedHeight);
                placements.push({
                    block: item.block,
                    variant: c.variant,
                    x: s.x + c.padX,
                    y: s.y + c.padY,
                    width: c.variant.width,
                    height: c.variant.height,
                });
                placed = true;
                break;
            }
        }

        if (!placed) {
            const usedHeightNow = usedHeightFromPlacements(placements, outlineMarginMm);
            return { success: false, placements, usedHeight: usedHeightNow };
        }
    }

    const usedHeightCalc = usedHeightFromPlacements(placements, outlineMarginMm);
    return { success: true, placements, usedHeight: usedHeightCalc };
}


export async function progressivePackDrawableBlocks(
    blocks: DrawableBlock[],
    fabricWidth: number,
    rotationStep: number | null,
    options?: ProgressivePackOptions
): Promise<{ placements: PlacedDrawableBlock[]; usedHeight: number } | null> {
    if (!fabricWidth || fabricWidth <= 0) throw new Error("Fabric width must be greater than zero for packing.");
    if (!blocks.length) return { placements: [], usedHeight: 0 };

    const outlineMarginMm = Math.max(0, options?.outlineMarginMm ?? 0);

    const items = preparePackItems(blocks, fabricWidth, rotationStep, outlineMarginMm);
    const totalArea = items.reduce((sum, i) => sum + i.minArea, 0);
    const maxItemHeight = items.reduce((m, i) => Math.max(m, i.minHeight), 0);
    const candidateHeights = buildCandidateHeights(totalArea, fabricWidth, maxItemHeight);
    const orders = buildCandidateOrders(items, options?.maxRandomOrders ?? 10);

    let best: { placements: PlacedDrawableBlock[]; usedHeight: number } | null = null;

    for (let i = 0; i < orders.length; i += 1) {
        const attemptResult = await tryPackOrderProgressive(orders[i], fabricWidth, candidateHeights, {
            ...options,
            attempt: i + 1,
            totalAttempts: orders.length,
            totalPieces: items.length,
            bestHeight: best?.usedHeight,
            totalArea,
            fabricWidth,
            outlineMarginMm,
        });
        if (attemptResult.stopped) return null;
        if (attemptResult.success && attemptResult.result) {
            options?.onAttemptResult?.({
                placements: attemptResult.result.placements,
                usedHeight: attemptResult.result.usedHeight,
                attempt: i + 1,
                totalAttempts: orders.length,
                waste: computeWaste(attemptResult.result.placements, fabricWidth, undefined, outlineMarginMm),
            });
            if (isBetterLayout(attemptResult.result, best, fabricWidth, totalArea)) {
                best = attemptResult.result;
            }
        }
    }

    if (best) return best;

    // As a fallback, use synchronous pack to try to produce a layout
    try {
        return packDrawableBlocks(blocks, fabricWidth, rotationStep, { orderTrials: options?.maxRandomOrders, outlineMarginMm });
    } catch {
        return null;
    }
}

export async function tryPackOrderProgressive(
    order: PackedItem[],
    fabricWidth: number,
    candidateHeights: number[],
    options: ProgressiveAttemptOptions
): Promise<{ success: boolean; result: { placements: PlacedDrawableBlock[]; usedHeight: number } | null; stopped: boolean }> {
    let best: { placements: PlacedDrawableBlock[]; usedHeight: number } | null = null;
    for (const height of candidateHeights) {
        if (options.shouldStop?.()) return { success: false, result: null, stopped: true };
        const res = await placeOrderProgressive(order, fabricWidth, height, options);
        if (res.stopped) return { success: false, result: null, stopped: true };
        if (res.success) {
            if (!best || res.usedHeight < best.usedHeight - POSITION_EPS) {
                best = { placements: res.placements, usedHeight: res.usedHeight };
            }
        }
    }
    return { success: Boolean(best), result: best, stopped: false };
}

export async function placeOrderProgressive(
    order: PackedItem[],
    fabricWidth: number,
    height: number,
    options: ProgressiveAttemptOptions
): Promise<{ success: boolean; placements: PlacedDrawableBlock[]; usedHeight: number; stopped: boolean }> {
    const placements: PlacedDrawableBlock[] = [];
    const root: PackNode = { x: 0, y: 0, width: fabricWidth, height };
    let step = 0;

    const outlineMarginMm = Math.max(0, options.outlineMarginMm ?? 0);

    for (const item of order) {
        if (options.shouldStop?.()) return { success: false, placements, usedHeight: usedHeightFromPlacements(placements, outlineMarginMm), stopped: true };
        let placed = false;
        const candidates = item.variants
            .slice()
            .sort((a, b) => {
                const wa = Math.min(a.paddedWidth, fabricWidth) / fabricWidth;
                const wb = Math.min(b.paddedWidth, fabricWidth) / fabricWidth;
                if (wb !== wa) return wb - wa;
                return a.paddedHeight - b.paddedHeight;
            });

        for (const c of candidates) {
            if (c.paddedWidth > fabricWidth + 1e-6) continue;
            const node = findNode(root, c.paddedWidth, c.paddedHeight);
            if (node) {
                const s = splitNode(node, c.paddedWidth, c.paddedHeight);
                placements.push({
                    block: item.block,
                    variant: c.variant,
                    x: s.x + c.padX,
                    y: s.y + c.padY,
                    width: c.variant.width,
                    height: c.variant.height,
                });
                placed = true;
                break;
            }
        }

        if (!placed) {
            return { success: false, placements, usedHeight: usedHeightFromPlacements(placements, outlineMarginMm), stopped: false };
        }

        step += 1;
        const usedNow = usedHeightFromPlacements(placements, outlineMarginMm);
        if (options.onPlacement) {
            options.onPlacement({
                placements: clonePlacements(placements),
                usedHeight: usedNow,
                placed: placements.length,
                total: options.totalPieces,
                attempt: options.attempt,
                totalAttempts: options.totalAttempts,
                bestHeight: options.bestHeight,
            });
        }

        if (step % 3 === 0) await yieldToBrowser();
    }

    return { success: true, placements, usedHeight: usedHeightFromPlacements(placements, outlineMarginMm), stopped: false };
}

export function clonePlacements(list: PlacedDrawableBlock[]): PlacedDrawableBlock[] {
    return list.map((p) => ({ ...p }));
}

export function usedHeightFromPlacements(list: PlacedDrawableBlock[], outlineMarginMm: number = 0): number {
    const m = Math.max(0, outlineMarginMm || 0);
    return list.reduce((acc, p) => Math.max(acc, p.y + p.height + m), 0);
}

export function polygonArea(points: Point[]): number {
    if (points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i += 1) {
        const j = (i + 1) % points.length;
        area += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return Math.abs(area) / 2;
}

export function computePathArea(path: PolylinePath): number {
    if (!path.closed || path.points.length < 3) return 0;
    return polygonArea(path.points);
}

export function computeClosedPathUnionArea(paths: PolylinePath[]): number {
    const closed = (paths ?? []).filter(
        (path) => path.closed && (path.points?.length ?? 0) >= 3
    );
    if (!closed.length) return 0;

    try {
        const CL: any = (ClipperLib as any)?.default ?? (ClipperLib as any);
        if (!CL?.Clipper) throw new Error("Clipper unavailable");
        const SCALE = 1000;
        const subjects = closed.map((path) => {
            const polygon = path.points.map((point) => ({
                X: Math.round(point.x * SCALE),
                Y: Math.round(point.y * SCALE),
            }));
            // Treat every closed packing contour as occupied material. DXF
            // contour direction is inconsistent and must not cancel overlaps.
            if (Number(CL.Clipper.Area(polygon)) < 0) polygon.reverse();
            return polygon;
        });
        const clipper = new CL.Clipper();
        clipper.AddPaths(subjects, CL.PolyType.ptSubject, true);
        const solution: any[] = [];
        clipper.Execute(
            CL.ClipType.ctUnion,
            solution,
            CL.PolyFillType.pftNonZero,
            CL.PolyFillType.pftNonZero
        );
        return (solution || []).reduce(
            (sum: number, polygon: any[]) =>
                sum + Math.abs(Number(CL.Clipper.Area(polygon)) || 0) / (SCALE * SCALE),
            0
        );
    } catch {
        // A block normally contains overlapping representations of the same
        // physical boundary. The largest contour is safer than summing them.
        return closed.reduce((largest, path) => Math.max(largest, computePathArea(path)), 0);
    }
}

export function computeBlockOutlineArea(block: DrawableBlock): number {
    const source = block.packPaths?.length ? block.packPaths : block.paths;
    // packPaths can contain the cut line and the graded/render outline at the
    // same time. Summing them double-counts overlapping material and can make
    // the piece area larger than the complete fabric rectangle.
    return computeClosedPathUnionArea(source);
}

export function computePlacementArea(list: PlacedDrawableBlock[]): number {
    return list.reduce((sum, p) => sum + computeBlockOutlineArea(p.block), 0);
}

export function computeWaste(list: PlacedDrawableBlock[], fabricWidth: number, totalArea?: number, outlineMarginMm: number = 0): number {
    const usedHeight = usedHeightFromPlacements(list, outlineMarginMm);
    const placedArea = totalArea && Number.isFinite(totalArea) && totalArea > 0 ? totalArea : computePlacementArea(list);
    const fabricArea = fabricWidth * Math.max(usedHeight, 1e-6);
    if (!fabricArea) return 1;
    return Math.max(0, Math.min(1, 1 - placedArea / fabricArea));
}

export function yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

export function isBetterLayout(
    candidate: { usedHeight: number },
    current: { usedHeight: number } | null,
    fabricWidth: number,
    totalArea: number
): boolean {
    if (!current) return true;
    const wasteCandidate = fabricWidth * candidate.usedHeight - totalArea;
    const wasteCurrent = fabricWidth * current.usedHeight - totalArea;
    const WASTE_EPS = 1e-3;
    const HEIGHT_EPS = 0.5; // mm

    // 1) Prefer clearly shorter layouts even if waste increases.
    if (candidate.usedHeight < current.usedHeight - HEIGHT_EPS) return true;

    // 2) If heights are effectively equal, pick less waste.
    if (Math.abs(candidate.usedHeight - current.usedHeight) <= HEIGHT_EPS) {
        if (wasteCandidate < wasteCurrent - WASTE_EPS) return true;
        return false;
    }

    // 3) If candidate is taller, only accept if it reduces waste meaningfully.
    if (wasteCandidate < wasteCurrent - WASTE_EPS * 5) return true;

    return false;
}

export function parseSizeFilterToSet(input: string): Set<string> | null {
    if (!input.trim()) return null;
    const tokens = input
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    return tokens.length ? new Set(tokens) : null;
}

type BlockNameInfo = { pieceLabel: string; sizeLabel?: string };

export function parseRotationHintFromName(name: string): number | null | undefined {
    const match = name.match(/(?:rot|rotation|r)(\d{1,3})/i);
    if (!match) return undefined;
    const val = Number(match[1]);
    if (!Number.isFinite(val)) return undefined;
    if (val <= 0) return null; // explicitly disallow rotation for this piece
    return Math.min(180, val);
}

export function deriveGroupIdFromName(name: string): string | undefined {
    const cleaned = name.trim();
    if (!cleaned) return undefined;
    // Use the first token before an underscore or whitespace as the group key
    const first = cleaned.split(/[_\s]+/)[0];
    return first || undefined;
}

export function deriveBlockNameMap(blocks: Record<string, DxfBlock>): Map<string, BlockNameInfo> {
    const variantSets = new Map<string, Set<string>>();

    // Pass 1: collect variant tokens per prefix
    for (const name of Object.keys(blocks)) {
        const tokens = name.split("_");
        if (tokens.length <= 1) continue;
        const prefix = tokens.slice(0, -1).join(" ") || name.replace(/_/g, " ");
        const variant = tokens[tokens.length - 1].toLowerCase();
        const set = variantSets.get(prefix) ?? new Set<string>();
        set.add(variant);
        variantSets.set(prefix, set);
    }

    // Pass 2: decide per block whether the last token is a size (only if prefix has >1 variants)
    const result = new Map<string, BlockNameInfo>();
    for (const name of Object.keys(blocks)) {
        const tokens = name.split("_");
        if (tokens.length <= 1) {
            result.set(name, { pieceLabel: name.replace(/_/g, " "), sizeLabel: undefined });
            continue;
        }
        const prefix = tokens.slice(0, -1).join(" ") || name.replace(/_/g, " ");
        const variant = tokens[tokens.length - 1].toLowerCase();
        const variantsForPrefix = variantSets.get(prefix);
        if (variantsForPrefix && variantsForPrefix.size > 1) {
            result.set(name, { pieceLabel: prefix, sizeLabel: variant });
        } else {
            result.set(name, { pieceLabel: name.replace(/_/g, " "), sizeLabel: undefined });
        }
    }

    return result;
}


export function buildInsertTransform(entity: DxfEntity): InsertTransform {
    const translationX = Number.isFinite(entity.position?.x) ? (entity.position!.x as number) : 0;
    const translationY = Number.isFinite(entity.position?.y) ? (entity.position!.y as number) : 0;
    const rotation = Number.isFinite(entity.rotation) ? (entity.rotation as number) : 0;
    const uniformScale = Number.isFinite(entity.scale) ? (entity.scale as number) : undefined;
    const scaleX = Number.isFinite(entity.xScale) ? (entity.xScale as number) : uniformScale ?? 1;
    const scaleY = Number.isFinite(entity.yScale) ? (entity.yScale as number) : uniformScale ?? 1;
    return { translationX, translationY, rotation, scaleX, scaleY };
}
export function transformInsertPaths(paths: PolylinePath[], t: InsertTransform): PolylinePath[] {
    const rad = (t.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return paths.map((path) => ({
        ...path,
        points: path.points.map((p) => {
            const sx = p.x * t.scaleX;
            const sy = p.y * t.scaleY;
            const rx = sx * cos - sy * sin;
            const ry = sx * sin + sy * cos;
            return { x: rx + t.translationX, y: ry + t.translationY };
        }),
    }));
}

export function applyBoundsTransform(
    paths: PolylinePath[],
    from: Bounds,
    to: Bounds
): PolylinePath[] {
    const fromW = Math.max(1e-6, from.maxX - from.minX);
    const fromH = Math.max(1e-6, from.maxY - from.minY);
    const toW = to.maxX - to.minX;
    const toH = to.maxY - to.minY;

    const sx = toW / fromW;
    const sy = toH / fromH;
    // Grade relative to the original DXF origin by anchoring at min corner, not the center.
    return paths.map((path) => ({
        ...path,
        points: path.points.map((pt) => ({
            x: (pt.x - from.minX) * sx + to.minX,
            y: (pt.y - from.minY) * sy + to.minY,
        })),
    }));
}

export function applyBoundsTransformPreservePointMarkers(
    paths: PolylinePath[],
    from: Bounds,
    to: Bounds,
    markerHalfMm = 1.5
): PolylinePath[] {
    const fromW = Math.max(1e-6, from.maxX - from.minX);
    const fromH = Math.max(1e-6, from.maxY - from.minY);
    const toW = to.maxX - to.minX;
    const toH = to.maxY - to.minY;

    const sx = toW / fromW;
    const sy = toH / fromH;

    const transformPoint = (pt: Point): Point => ({
        x: (pt.x - from.minX) * sx + to.minX,
        y: (pt.y - from.minY) * sy + to.minY,
    });


    return paths.map((path) => {
        if (path.marker !== "point" || path.points.length !== 2) {
            return {
                ...path,
                points: path.points.map(transformPoint),
            };
        }

        const a = path.points[0];
        const b = path.points[1];
        const center = transformPoint({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        const half = Number.isFinite(markerHalfMm) && markerHalfMm > 0 ? markerHalfMm : 1.5;

        // Rebuild an axis-aligned tiny cross segment (size stays constant across grading).
        const isHorizontal = Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);
        const points = isHorizontal
            ? [{ x: center.x - half, y: center.y }, { x: center.x + half, y: center.y }]
            : [{ x: center.x, y: center.y - half }, { x: center.x, y: center.y + half }];

        return { ...path, points };
    });
}



export function extractDrawablePaths(
    block?: DxfBlock | null,
    options: DrawPathOptions = {}
): PolylinePath[] {
    if (!block?.entities?.length) return [];

    const includeHelperLines = Boolean(options.includeHelperLines);
    const visited = new Set(options.visited ?? []);
    if (options.blockName) {
        if (visited.has(options.blockName)) return [];
        visited.add(options.blockName);
    }

    const OUTLINE_LAYERS = new Set(["14", "87", "86", "85", "84", "83", "82", "81"]);
    // Layer 1 is the physical cutting boundary. It retains the legacy `seam`
    // kind internally because grading/packing algorithms use that bucket for
    // the outer contour, while semanticRole carries the process meaning.
    const SEAM_LAYERS = new Set(["1"]);
    const IGNORE_LAYERS = new Set([]);

    type Kind = "outline" | "seam" | "helper";
    const raw: Array<PolylinePath & { kind: Kind }> = [];

    for (const entity of block.entities!) {
        if (!entity || !entity.type) continue;
        const layer = String(entity.layer ?? "");
        if (IGNORE_LAYERS.has(layer)) continue;

        if (entity.type === "INSERT" && entity.name && options.blocks) {
            const target = options.blocks[entity.name];
            if (target && target.entities?.length) {
                const nested = extractDrawablePaths(target, {
                    ...options,
                    blockName: entity.name,
                    visited,
                });
                const t = buildInsertTransform(entity);
                raw.push(
                    ...transformInsertPaths(nested, t).map((p) => ({
                        ...p,
                        kind: "helper" as Kind,
                    }))
                );
            }
            continue;
        }

        if (entity.type === "POLYLINE" && entity.vertices?.length) {
            const basePts = entity.vertices.map((v) => ({ x: v.x, y: v.y, bulge: (v as any)?.bulge }));
            const closed = Boolean(
                entity.shape ||
                entity.closed ||
                arePointsEqual(basePts[0], basePts[basePts.length - 1])
            );
            const pts = expandPolylineWithBulge(basePts, closed);
            let kind: Kind = "helper";
            if (OUTLINE_LAYERS.has(layer)) kind = "outline";
            else if (SEAM_LAYERS.has(layer)) kind = "seam";
            // console.log("entity.polyType", entity, entity.polyType);
            raw.push({
                points: pts,
                closed,
                kind,
                layer,
                semanticRole: getDxfLayerSemanticRole(layer),
                polyType: entity.polyType,
            });
            continue;
        }

        if (entity.type === "CIRCLE" && entity.center && typeof entity.radius === "number") {
            const { center, radius } = entity;
            if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || !Number.isFinite(radius) || radius <= 0) continue;
            // A full circle needs its own sampling: arc angle normalization
            // maps 360 degrees back to zero and would collapse its sweep.
            const pts = Array.from({ length: 180 }, (_, i) => {
                const angle = (i / 180) * Math.PI * 2;
                return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
            });
            let kind: Kind = "helper";
            if (OUTLINE_LAYERS.has(layer)) kind = "outline";
            else if (SEAM_LAYERS.has(layer)) kind = "seam";
            raw.push({
                points: pts,
                closed: true,
                kind,
                layer,
                semanticRole: getDxfLayerSemanticRole(layer),
            });
            continue;
        }

        if (entity.type === "ARC" && entity.center && typeof entity.radius === "number") {
            const startAngle = typeof (entity as any).startAngle === "number" ? (entity as any).startAngle : 0;
            const endAngle = typeof (entity as any).endAngle === "number" ? (entity as any).endAngle : 0;
            const pts = approximateArcByCenter(entity.center, entity.radius, startAngle, endAngle, 2);
            if (pts.length >= 2) {
                let kind: Kind = "helper";
                if (OUTLINE_LAYERS.has(layer)) kind = "outline";
                else if (SEAM_LAYERS.has(layer)) kind = "seam";
                raw.push({
                    points: pts,
                    closed: false,
                    kind,
                    layer,
                    semanticRole: getDxfLayerSemanticRole(layer),
                });
            }
            continue;
        }

        if (entity.type === "LINE" && entity.vertices?.length === 2) {
            const pts = entity.vertices.map((v) => ({ x: v.x, y: v.y }));
            let kind: Kind = "helper";
            if (OUTLINE_LAYERS.has(layer)) kind = "outline";
            else if (SEAM_LAYERS.has(layer)) kind = "seam";
            raw.push({
                points: pts,
                closed: false,
                kind,
                layer,
                semanticRole: getDxfLayerSemanticRole(layer),
            });
            continue;
        }

        // Keep every DXF POINT for grading/validation. Only layer-4 notch points
        // are physical marks; layers 2/3 remain non-plot metadata.
        if (entity.type === "POINT" && entity.position) {
            const x = Number(entity.position.x ?? 0);
            const y = Number(entity.position.y ?? 0);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                const half = 1.5; // mm; small but visible when zoomed
                const kind: Kind = "helper";
                const pointRole = getDxfPointRole(layer);
                const semanticRole = getDxfLayerSemanticRole(layer);
                raw.push({
                    points: [{ x: x - half, y }, { x: x + half, y }],
                    closed: false,
                    kind,
                    layer,
                    marker: "point",
                    pointRole,
                    semanticRole,
                });
                raw.push({
                    points: [{ x, y: y - half }, { x, y: y + half }],
                    closed: false,
                    kind,
                    layer,
                    marker: "point",
                    pointRole,
                    semanticRole,
                });
            }
            continue;
        }
    }

    if (!raw.length) return [];

    const outlines = raw.filter(
        (p) => p.kind === "outline" && p.closed && p.points.length >= 3
    );
    const seams = raw.filter((p) => p.kind === "seam");
    const helpers = raw.filter((p) => p.kind === "helper");

    let main: (PolylinePath & { kind?: Kind }) | null = null;
    if (outlines.length) {
        // Prefer the canonical CLO "net outline" on layer 14 when available.
        // Some exports include additional closed polylines on layers 81-87 (e.g. seam allowance / cut outline),
        // and picking the largest extent can select the wrong contour for a single size.
        const preferred = outlines.filter((p) => String(p.layer ?? "") === "14");
        const candidates = preferred.length ? preferred : outlines;

        let best = candidates[0];
        let bestScore = extentScore(best.points);
        for (let i = 1; i < candidates.length; i += 1) {
            const s = extentScore(candidates[i].points);
            if (s > bestScore) {
                best = candidates[i];
                bestScore = s;
            }
        }
        main = {
            points: best.points,
            closed: true,
            layer: normalizeDxfLayer(best.layer) === "87" ? "14" : best.layer,
            kind: "outline",
            semanticRole: normalizeDxfLayer(best.layer) === "87"
                ? "sewingLine"
                : getDxfLayerSemanticRole(best.layer),
        };
    } else {
        const closedFallback = raw.filter(
            (p) => p.closed && p.points.length >= 3
        );
        if (closedFallback.length) {
            let best = closedFallback[0];
            let bestScore = extentScore(best.points);
            for (let i = 1; i < closedFallback.length; i += 1) {
                const s = extentScore(closedFallback[i].points);
                if (s > bestScore) {
                    best = closedFallback[i];
                    bestScore = s;
                }
            }
            main = {
                points: best.points,
                closed: true,
                layer: normalizeDxfLayer(best.layer) === "87" ? "14" : best.layer,
                kind: "outline",
                semanticRole: normalizeDxfLayer(best.layer) === "87"
                    ? "sewingLine"
                    : getDxfLayerSemanticRole(best.layer),
            };
        }
    }

    if (!includeHelperLines) {
        if (main) {
            return [
                {
                    points: main.points,
                    closed: main.closed,
                    layer: main.layer,
                    kind: "outline",
                    semanticRole: main.semanticRole,
                },
                ...seams.map(({ points, closed, layer, semanticRole }) => ({
                    points,
                    closed,
                    layer,
                    kind: "seam" as const,
                    semanticRole,
                })),
                ...helpers
                    .filter((path) => path.marker === "point")
                    .map(({ points, closed, layer, marker, pointRole, semanticRole }) => ({
                        points,
                        closed,
                        layer,
                        kind: "helper" as const,
                        marker,
                        pointRole,
                        semanticRole,
                    })),
            ];
        }
        return raw.map(({ kind, layer, ...rest }) => ({ ...rest, layer, kind }));
    }

    const result: PolylinePath[] = [];
    if (main)
        result.push({
            points: main.points,
            closed: main.closed,
            layer: main.layer,
            kind: "outline",
            semanticRole: main.semanticRole,
        });

    // Keep additional closed outline candidates (e.g. layers 81-87) available for display.
    // We don't treat them as primary outlines for packing, but downstream we can promote
    // the best-matching, higher-resolution curve for rendering.
    if (main && outlines.length > 1) {
        for (const o of outlines) {
            if (o === (outlines.find((p) => p.points === main!.points) ?? null)) continue;
            // Avoid re-adding the same geometry.
            if (o.points === main.points) continue;
            result.push({
                points: o.points,
                closed: Boolean(o.closed),
                layer: o.layer,
                kind: "helper" as const,
                semanticRole: getDxfLayerSemanticRole(o.layer),
                polyType: (o as any).polyType,
            });
        }
    }
    result.push(
        ...seams.map(({ points, closed, layer, semanticRole }) => ({
            points,
            closed,
            layer,
            kind: "seam" as const,
            semanticRole,
        })),
        // Preserve POINT marker metadata so grading/propagation logic can treat them correctly.
        ...helpers.map(({ points, closed, layer, marker, pointRole, semanticRole, polyType }) => ({
            points,
            closed,
            layer,
            kind: "helper" as const,
            marker,
            pointRole,
            semanticRole,
            polyType,
        }))
    );
    return result;
}



export const placementClosedPathsInWorld = (placement: PlacedDrawableBlock): Point[][] => {
    const source = placement.variant.packPaths?.length
        ? placement.variant.packPaths
        : placement.variant.paths;
    const anchor = placement.variant.renderBounds ?? placement.variant.bounds;

    return (source ?? [])
        .filter((path) => path.closed && (path.points?.length ?? 0) >= 3)
        .map((path) =>
            path.points.map((point) => ({
                x: placement.x + point.x - anchor.minX,
                y: placement.y + point.y - anchor.minY,
            }))
        );
};

export const placementsHavePhysicalOverlap = (
    first: PlacedDrawableBlock,
    second: PlacedDrawableBlock
): boolean => {
    // Real-bounding layouts deliberately let the rectangular bounds interlock.
    // Only run the more expensive polygon test when those rectangles intersect.
    const boundsOverlap =
        first.x < second.x + second.width - POSITION_EPS &&
        first.x + first.width - POSITION_EPS > second.x &&
        first.y < second.y + second.height - POSITION_EPS &&
        first.y + first.height - POSITION_EPS > second.y;
    if (!boundsOverlap) return false;

    const firstPolygons = placementClosedPathsInWorld(first);
    const secondPolygons = placementClosedPathsInWorld(second);
    if (!firstPolygons.length || !secondPolygons.length) {
        // Keep the conservative legacy behavior if a malformed block has no
        // closed contour with which to prove that the overlap is harmless.
        return true;
    }

    try {
        const CL: any = (ClipperLib as any)?.default ?? (ClipperLib as any);
        if (!CL?.Clipper) throw new Error("Clipper unavailable");
        const SCALE = 1000;
        const toClipperPaths = (polygons: Point[][]) =>
            polygons.map((points) => {
                const polygon = points.map((point) => ({
                    X: Math.round(point.x * SCALE),
                    Y: Math.round(point.y * SCALE),
                }));
                // Packing treats every closed contour as occupied material.
                // Normalize winding so duplicate DXF contours cannot cancel.
                if (Number(CL.Clipper.Area(polygon)) < 0) polygon.reverse();
                return polygon;
            });

        const clipper = new CL.Clipper();
        clipper.AddPaths(toClipperPaths(firstPolygons), CL.PolyType.ptSubject, true);
        clipper.AddPaths(toClipperPaths(secondPolygons), CL.PolyType.ptClip, true);
        const intersection: any[] = [];
        clipper.Execute(
            CL.ClipType.ctIntersection,
            intersection,
            CL.PolyFillType.pftNonZero,
            CL.PolyFillType.pftNonZero
        );
        const intersectionArea = (intersection ?? []).reduce(
            (sum: number, polygon: any[]) =>
                sum + Math.abs(Number(CL.Clipper.Area(polygon)) || 0) / (SCALE * SCALE),
            0
        );
        // Edge contact and tiny integer-rounding artifacts are valid. A real
        // material collision has a measurable intersection area.
        return intersectionArea > 0.01;
    } catch {
        return true;
    }
};

export function validateRealBoundingPlacements(
    placements: PlacedDrawableBlock[],
    fabricWidth: number
): boolean {
    for (let index = 0; index < placements.length; index += 1) {
        const placement = placements[index];
        if (
            placement.x < -POSITION_EPS ||
            placement.y < -POSITION_EPS ||
            placement.x + placement.width > fabricWidth + POSITION_EPS
        ) {
            return false;
        }
        for (let otherIndex = index + 1; otherIndex < placements.length; otherIndex += 1) {
            if (placementsHavePhysicalOverlap(placement, placements[otherIndex])) return false;
        }
    }
    return true;
}

type VectorCompactionOptions = {
    passes?: number;
    shouldStop?: () => boolean;
};

const uniqueSortedCoordinates = (values: number[], maximum: number): number[] => {
    const seen = new Set<number>();
    for (const raw of values) {
        if (!Number.isFinite(raw)) continue;
        const value = Math.max(0, Math.min(maximum, raw));
        seen.add(Math.round(value * 1000));
    }
    return Array.from(seen, (value) => value / 1000).sort((a, b) => a - b);
};

/**
 * Refines a conservative raster result with exact polygon intersections.
 *
 * Each piece is removed and reinserted at strip/bounding-contact coordinates.
 * This recovers sub-grid gaps and can move a formerly stacked piece beside an
 * existing piece, while Clipper remains the final collision authority.
 */
export function compactPlacementsVector(
    input: PlacedDrawableBlock[],
    fabricWidth: number,
    options?: VectorCompactionOptions
): { placements: PlacedDrawableBlock[]; usedHeight: number } | null {
    const placements = input.map((placement) => ({ ...placement }));
    if (!validateRealBoundingPlacements(placements, fabricWidth)) return null;

    const passes = Math.max(1, Math.min(4, Math.floor(options?.passes ?? 2)));
    for (let pass = 0; pass < passes; pass += 1) {
        if (options?.shouldStop?.()) return null;
        let changed = false;
        const order = placements
            .map((placement, index) => ({ index, top: placement.y + placement.height }))
            .sort((a, b) => b.top - a.top || b.index - a.index);

        for (const entry of order) {
            if (options?.shouldStop?.()) return null;
            const moving = placements[entry.index];
            const others = placements.filter((_, index) => index !== entry.index);
            const maxX = Math.max(0, fabricWidth - moving.width);
            const xCoordinates = uniqueSortedCoordinates(
                [
                    0,
                    moving.x,
                    ...others.flatMap((other) => [
                        other.x + other.width,
                        other.x - moving.width,
                    ]),
                ],
                maxX
            );

            const currentHeight = usedHeightFromPlacements(placements);
            let best = { ...moving };
            let bestHeight = currentHeight;

            for (const x of xCoordinates) {
                const yCoordinates = uniqueSortedCoordinates(
                    [
                        0,
                        moving.y,
                        ...others.flatMap((other) => [
                            other.y + other.height,
                            other.y - moving.height,
                        ]),
                    ],
                    Math.max(0, moving.y)
                );

                for (const y of yCoordinates) {
                    if (options?.shouldStop?.()) return null;
                    const candidate = { ...moving, x, y };
                    if (others.some((other) => placementsHavePhysicalOverlap(candidate, other))) continue;

                    const candidateHeight = Math.max(
                        candidate.y + candidate.height,
                        ...others.map((other) => other.y + other.height),
                        0
                    );
                    const isBetter =
                        candidateHeight < bestHeight - POSITION_EPS ||
                        (
                            Math.abs(candidateHeight - bestHeight) <= POSITION_EPS &&
                            (
                                candidate.y < best.y - POSITION_EPS ||
                                (
                                    Math.abs(candidate.y - best.y) <= POSITION_EPS &&
                                    candidate.x < best.x - POSITION_EPS
                                )
                            )
                        );
                    if (isBetter) {
                        best = candidate;
                        bestHeight = candidateHeight;
                    }
                }
            }

            if (
                Math.abs(best.x - moving.x) > POSITION_EPS ||
                Math.abs(best.y - moving.y) > POSITION_EPS
            ) {
                placements[entry.index] = best;
                changed = true;
            }
        }

        if (!changed) break;
    }

    if (!validateRealBoundingPlacements(placements, fabricWidth)) return null;
    return {
        placements,
        usedHeight: usedHeightFromPlacements(placements),
    };
}

// Build placements from DXF INSERT entities if present; otherwise return empty
export function placementsFromDxf(dxf: DxfFile, drawables: DrawableBlock[]): { placements: PlacedDrawableBlock[]; usedHeight: number } {
    const entities = Array.isArray(dxf.entities) ? dxf.entities : [];
    if (!entities.length || !dxf.blocks) return { placements: [], usedHeight: 0 };

    // Saved layouts are exported with sanitized block names (see export-layout.ts):
    // `name.replace(/[^A-Za-z0-9_\-]/g, "_")`. Match both raw and sanitized names.
    const sanitize = (name: string) => {
        const safe = String(name || "PIECE").replace(/[^A-Za-z0-9_\-]/g, "_");
        return safe || "PIECE";
    };

    const byName: Record<string, DrawableBlock> = {};
    for (const d of drawables) {
        byName[d.name] = d;
        const s = sanitize(d.name);
        if (!byName[s]) byName[s] = d;
    }
    const placements: PlacedDrawableBlock[] = [];
    for (const e of entities) {
        if (e.type !== "INSERT" || !e.name) continue;
        const block = byName[e.name] ?? byName[sanitize(e.name)];
        if (!block) continue;
        const variant = createBlockVariant(block, 0);
        // DXF semantics: INSERT position is the block base point (0,0) in WCS.
        // Our placements use a min-corner anchor, i.e. the placement origin corresponds to variant bounds minX/minY.
        // Convert INSERT origin -> placement origin so layouts round-trip without drifting.
        const insertX = Number.isFinite(e.position?.x) ? (e.position!.x as number) : 0;
        const insertY = Number.isFinite(e.position?.y) ? (e.position!.y as number) : 0;
        const b = (variant as any).renderBounds ?? variant.bounds;
        const x = insertX + (Number.isFinite(b?.minX) ? Number(b.minX) : 0);
        const y = insertY + (Number.isFinite(b?.minY) ? Number(b.minY) : 0);
        placements.push({
            block,
            variant,
            x,
            y,
            width: variant.width,
            height: variant.height,
        });
    }
    const usedHeight = placements.reduce((m, p) => Math.max(m, p.y + p.height), 0);
    const hasOverlap = placements.length > 1 && placements.some((placement, index) =>
        placements
            .slice(index + 1)
            .some((other) => placementsHavePhysicalOverlap(placement, other))
    );
    if (hasOverlap) {
        return { placements: [], usedHeight: 0 };
    }
    return { placements, usedHeight };
}

export function extentScore(points: Point[]): number {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const p of points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
    return w * h;
}

export function arePointsEqual(a: Point, b: Point) {
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

function degToRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

function approximateArcByCenter(
    center: Point,
    radius: number,
    startDeg: number,
    endDeg: number,
    stepDeg: number = 2
): Point[] {
    if (!Number.isFinite(radius) || radius <= 0) return [];
    const start = degToRad(normalizeAngle(startDeg));
    let end = degToRad(normalizeAngle(endDeg));

    // DXF arcs are typically CCW from start -> end (wrap permitted)
    while (end < start) end += Math.PI * 2;
    const sweep = end - start;
    const segments = Math.max(2, Math.ceil((sweep * 180) / (Math.PI * Math.max(1, stepDeg))));
    const pts: Point[] = [];
    for (let i = 0; i <= segments; i += 1) {
        const t = start + (sweep * i) / segments;
        pts.push({ x: center.x + radius * Math.cos(t), y: center.y + radius * Math.sin(t) });
    }
    return pts;
}

function expandPolylineWithBulge(
    vertices: Array<{ x: number; y: number; bulge?: number }>,
    closed: boolean
): Point[] {
    if (!vertices.length) return [];
    if (vertices.length === 1) return [{ x: vertices[0].x, y: vertices[0].y }];

    const pts: Point[] = [{ x: vertices[0].x, y: vertices[0].y }];
    const segCount = closed ? vertices.length : vertices.length - 1;

    for (let i = 0; i < segCount; i += 1) {
        const v1 = vertices[i];
        const v2 = vertices[(i + 1) % vertices.length];
        const b = Number.isFinite(v1?.bulge) ? Number(v1.bulge) : 0;

        const p1 = { x: v1.x, y: v1.y };
        const p2 = { x: v2.x, y: v2.y };
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const c = Math.hypot(dx, dy);

        if (!Number.isFinite(c) || c <= 1e-9 || !Number.isFinite(b) || Math.abs(b) <= 1e-9) {
            pts.push(p2);
            continue;
        }

        // Bulge definition: b = tan(theta/4), theta is signed included angle.
        // Sagitta (signed): s = b * chord / 2
        const s = (b * c) / 2;
        if (!Number.isFinite(s) || Math.abs(s) <= 1e-9) {
            pts.push(p2);
            continue;
        }

        // Distance from chord midpoint to circle center along left-normal (signed)
        // h = c^2/(8s) - s/2
        const h = (c * c) / (8 * s) - s / 2;
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        const nx = -dy / c;
        const ny = dx / c;
        const cx = mx + h * nx;
        const cy = my + h * ny;
        const r = Math.hypot(p1.x - cx, p1.y - cy);
        if (!Number.isFinite(r) || r <= 1e-9) {
            pts.push(p2);
            continue;
        }

        const startA = Math.atan2(p1.y - cy, p1.x - cx);
        const theta = 4 * Math.atan(b); // signed

        // Density: about 2 degrees per segment, min 2 (keeps curves smooth for offsets).
        const segs = Math.max(2, Math.ceil((Math.abs(theta) * 180) / (Math.PI * 2)));
        for (let k = 1; k <= segs; k += 1) {
            const a = startA + (theta * k) / segs;
            pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
        }
    }

    // Avoid duplicating first point for closed loops.
    if (closed && pts.length >= 2 && arePointsEqual(pts[0], pts[pts.length - 1])) {
        pts.pop();
    }
    return pts;
}



export function extractDxfAnnotations(block: DxfBlock, pieceLabel: string): DxfAnnotation[] {
    const normalizeLabel = (text: string) => text.trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
    const pieceNames = new Set([normalizeLabel(pieceLabel)]);
    for (const entity of block.entities ?? []) {
        const match = entity.type === "TEXT" && entity.text?.match(/^PIECE NAME:\s*(.*)$/i);
        if (match) pieceNames.add(normalizeLabel(match[1]));
    }
    return (block.entities ?? []).flatMap((entity): DxfAnnotation[] => {
        // ASTM layer 15 carries pattern annotations, including a redundant
        // piece name. Layers 1/14/8 also contain grading IDs and export metadata.
        if (entity.type !== "TEXT" || normalizeDxfLayer(entity.layer) !== "15") return [];
        const text = entity.text?.trim();
        const position = entity.position;
        const label = normalizeLabel(text ?? "");
        // Some exports mix UTF-8 metadata with legacy-encoded annotation
        // names. A replacement character may stand for a single umlaut.
        const isPieceName = Array.from(pieceNames).some((name) => name.length === label.length &&
            Array.from(label).every((char, i) => char === name[i] ||
                (char === "\uFFFD" && name.charCodeAt(i) > 127)));
        if (!text || isPieceName || !position ||
            !Number.isFinite(position.x) || !Number.isFinite(position.y)) return [];
        return [{
            text,
            position: { ...position },
            height: Number.isFinite(entity.textHeight) && entity.textHeight! > 0 ? entity.textHeight! : 5,
            rotation: Number.isFinite(entity.rotation) ? entity.rotation! : 0,
            layer: "15",
        }];
    });
}

export function buildDrawableBlocks(
    blocks: Record<string, DxfBlock>,
    sizeFilters: Set<string> | null,
    options?: {
        includeHelperLines?: boolean;
        helperBaseSizeLabel?: string | null;
        forceHelperBasePropagation?: boolean;
        /**
         * If true, may modify outline geometry to remove detected seam allowance on one outlier size.
         * Disabled by default because it can distort bounds and downstream grading.
         */
        fixSeamAllowanceOutline?: boolean;
        nameMap?: Map<string, BlockNameInfo>;
        debugHelpers?: boolean;
        disableHelperPropagation?: boolean;
    }
): DrawableBlock[] {
    const entries = Object.entries(blocks).sort(([a], [b]) =>
        a.localeCompare(b)
    );
    const includeHelpers = Boolean(options?.includeHelperLines);
    const manualBaseLabel = options?.helperBaseSizeLabel?.toLowerCase() ?? null;
    const forceHelperBasePropagation = Boolean(options?.forceHelperBasePropagation);
    const doFixSeamAllowance = Boolean(options?.fixSeamAllowanceOutline);

    type BlockInfo = {
        name: string;
        pieceLabel: string;
        sizeLabel?: string;
        groupId?: string;
        polyType?: number;
        rotationStepOverride?: number | null;
        outlinePaths: PolylinePath[];
        renderOutlinePaths?: PolylinePath[];
        sourceSeamPaths: PolylinePath[];
        seamPaths: PolylinePath[];
        helperPaths: PolylinePath[];
        annotations: DxfAnnotation[];
        outlineBounds: Bounds;
        area: number;
    };

    const perPiece = new Map<string, BlockInfo[]>();
    const baseInfoByPiece = new Map<string, { baseSize?: string | null; baseName?: string; helpers: number }>();
    const debugRows: Array<{
        piece: string;
        size: string;
        baseSize: string | null;
        baseName: string | null;
        baseHelpers: number;
        appliedHelpers: number;
        outlineSize: string;
    }> = [];
    const debug = Boolean(options?.debugHelpers);

    // --- Shared helper utilities (hoisted so seam propagation can reuse them) ---
    const SIZE_ORDER = ["xxxs", "xxs", "xs", "s", "m", "l", "xl", "xxl", "xxxl", "xxxxl", "xxxxxl"];
    const sizeRank = (label?: string | null): number => {
        const raw = String(label ?? "").trim().toLowerCase();
        const key = ({
            "3xs": "xxxs",
            "2xs": "xxs",
            "2xl": "xxl",
            "3xl": "xxxl",
            "4xl": "xxxxl",
            "5xl": "xxxxxl",
        } as Record<string, string>)[raw] ?? raw;
        const idx = SIZE_ORDER.indexOf(key);
        return idx >= 0 ? idx : 999;
    };

    const transformPath = (path: PolylinePath, t: { sx: number; sy: number; tx: number; ty: number }): PolylinePath => {
        const pts = (path.points ?? []).map((pt) => ({ x: pt.x * t.sx + t.tx, y: pt.y * t.sy + t.ty }));
        return { ...path, points: pts };
    };

    function pickMainClosedOutline(info: BlockInfo): PolylinePath | null {
        const candidates = ((info.renderOutlinePaths ?? info.outlinePaths) ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        if (!candidates.length) return null;
        let best = candidates[0];
        let bestScore = extentScore(best.points);
        for (let i = 1; i < candidates.length; i += 1) {
            const s = extentScore(candidates[i].points);
            if (s > bestScore) {
                best = candidates[i];
                bestScore = s;
            }
        }
        return best;
    }

    const polygonSignedArea = (pts: Point[]): number => {
        if (pts.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < pts.length; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            area += a.x * b.y - b.x * a.y;
        }
        return area / 2;
    };

    const canonicalizeClosedOutline = (ptsRaw: Point[]): { pts: Point[]; cum: number[]; total: number } | null => {
        const pts0 = (ptsRaw ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
        if (pts0.length < 3) return null;
        let pts = pts0.slice();
        if (pts.length >= 2 && arePointsEqual(pts[0], pts[pts.length - 1])) pts.pop();
        if (pts.length < 3) return null;
        if (polygonSignedArea(pts) < 0) pts = pts.slice().reverse();
        let bestIdx = 0;
        for (let i = 1; i < pts.length; i += 1) {
            const a = pts[i];
            const b = pts[bestIdx];
            if (a.x < b.x - 1e-6 || (Math.abs(a.x - b.x) <= 1e-6 && a.y < b.y - 1e-6)) bestIdx = i;
        }
        if (bestIdx > 0) pts = pts.slice(bestIdx).concat(pts.slice(0, bestIdx));
        const cum: number[] = [0];
        for (let i = 0; i < pts.length; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            cum.push(cum[cum.length - 1] + Math.hypot(b.x - a.x, b.y - a.y));
        }
        const total = cum[cum.length - 1] ?? 0;
        if (!(total > 1e-9)) return null;
        return { pts, cum, total };
    };

    const closestPointOnPolyline = (p: Point, pts: Point[], closed: boolean): { q: Point; segIdx: number; t: number; nx: number; ny: number } | null => {
        const n = pts.length;
        if (n < 2) return null;
        const segCount = closed ? n : n - 1;
        let bestD2 = Infinity;
        let best: { q: Point; segIdx: number; t: number; nx: number; ny: number } | null = null;
        for (let i = 0; i < segCount; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % n];
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const ab2 = abx * abx + aby * aby;
            if (ab2 <= 1e-12) continue;
            const apx = p.x - a.x;
            const apy = p.y - a.y;
            let t = (apx * abx + apy * aby) / ab2;
            t = Math.max(0, Math.min(1, t));
            const qx = a.x + t * abx;
            const qy = a.y + t * aby;
            const dx = p.x - qx;
            const dy = p.y - qy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                const len = Math.hypot(abx, aby) || 1;
                const nx = -aby / len;
                const ny = abx / len;
                best = { q: { x: qx, y: qy }, segIdx: i, t, nx, ny };
            }
        }
        return best;
    };

    const pointAtArcFraction = (canon: { pts: Point[]; cum: number[]; total: number }, frac: number): { p: Point; nx: number; ny: number } | null => {
        const pts = canon.pts;
        const n = pts.length;
        if (n < 2) return null;
        let target = Math.max(0, Math.min(1, frac)) * canon.total;
        for (let i = 0; i < n; i += 1) {
            const a = pts[i];
            const b = pts[(i + 1) % n];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len <= 1e-12) continue;
            if (target <= len) {
                const t = target / len;
                const px = a.x + t * dx;
                const py = a.y + t * dy;
                const nx = -dy / len;
                const ny = dx / len;
                return { p: { x: px, y: py }, nx, ny };
            }
            target -= len;
        }
        const a = pts[0];
        const b = pts[1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        return { p: { x: a.x, y: a.y }, nx: -dy / len, ny: dx / len };
    };

    const normalizeClosedPts = (ptsRaw: Point[]): Point[] => {
        const pts0 = (ptsRaw ?? []).filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
        if (pts0.length < 3) return [];
        const pts = pts0.slice();
        if (pts.length >= 2 && arePointsEqual(pts[0], pts[pts.length - 1])) pts.pop();
        return pts.length >= 3 ? pts : [];
    };

    type OutlineCorrespondence = { basePts: Point[]; targetPts: Point[]; shift: number };

    const buildOutlineCorrespondence = (baseRaw: Point[], targetRaw: Point[]): OutlineCorrespondence | null => {
        let basePts = normalizeClosedPts(baseRaw);
        let targetPts = normalizeClosedPts(targetRaw);
        if (basePts.length < 3 || targetPts.length < 3) return null;
        if (basePts.length !== targetPts.length) return null;

        if (polygonSignedArea(basePts) < 0) basePts = basePts.slice().reverse();
        if (polygonSignedArea(targetPts) < 0) targetPts = targetPts.slice().reverse();

        // CLO's ASTM grade blocks preserve control-vertex order across sizes.
        return { basePts, targetPts, shift: 0 };
    };

    const mapClosestPointToTarget = (corr: OutlineCorrespondence, p: Point): { base: { q: Point; segIdx: number; t: number; nx: number; ny: number }; target: { q: Point; nx: number; ny: number; tx: number; ty: number } } | null => {
        const hit = closestPointOnPolyline(p, corr.basePts, true);
        if (!hit) return null;
        const n = corr.targetPts.length;
        const a = corr.targetPts[(hit.segIdx + corr.shift) % n];
        const b = corr.targetPts[(hit.segIdx + 1 + corr.shift) % n];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const qx = a.x + Math.max(0, Math.min(1, hit.t)) * dx;
        const qy = a.y + Math.max(0, Math.min(1, hit.t)) * dy;
        const nx = -dy / len;
        const ny = dx / len;
        const tx = -ny;
        const ty = nx;
        return { base: hit, target: { q: { x: qx, y: qy }, nx, ny, tx, ty } };
    };

    // 1) Collect per-block geometry and group by piece
    for (const [name, block] of entries) {
        if (name.toLowerCase().startsWith("boundingbox_")) continue;

        const allPaths = extractDrawablePaths(block, {
            includeHelperLines: true,
            blocks,
            blockName: name,
        });
        if (!allPaths.length) continue;

        const outlines = allPaths.filter((p) => p.kind === "outline");
        const seams = allPaths.filter((p) => p.kind === "seam");
        const helpers = allPaths.filter((p) => p.kind === "helper");

        const primary =
            outlines[0] ??
            allPaths.find((p) => Boolean(p?.closed) && (p?.points?.length ?? 0) >= 3) ??
            allPaths[0] ??
            null;
        const outlineBounds = computeBounds(primary ? [primary] : allPaths);
        if (!outlineBounds) continue;

        const nameInfo = options?.nameMap?.get(name);
        const pieceLabel = nameInfo?.pieceLabel ?? name.replace(/_/g, " ");
        const sizeLabel = nameInfo?.sizeLabel;
        const groupId = deriveGroupIdFromName(name);
        const polyType =
            primary?.polyType ??
            outlines.find((p) => p.polyType !== undefined)?.polyType ??
            allPaths.find((p) => p.polyType !== undefined)?.polyType;

        const area =
            (outlineBounds.maxX - outlineBounds.minX) *
            (outlineBounds.maxY - outlineBounds.minY);

        const outlinePaths = outlines.length ? outlines : (primary ? [primary] : []);
        if (!outlinePaths.length) continue;

        const info: BlockInfo = {
            name,
            pieceLabel,
            sizeLabel,
            groupId,
            polyType,
            rotationStepOverride: parseRotationHintFromName(name),
            outlinePaths,
            sourceSeamPaths: seams,
            seamPaths: seams,     // keep as exported
            helperPaths: helpers, // may be repaired
            annotations: extractDxfAnnotations(blocks[name], pieceLabel),
            outlineBounds,
            area,
        };

        const key = pieceLabel.toLowerCase();
        const list = perPiece.get(key);
        if (list) list.push(info);
        else perPiece.set(key, [info]);
    }

    // 1b) Per-size display: prefer a high-resolution closed curve from the SAME size
    // (often on layers 81-87) when it matches the graded outline bounds.
    // This restores smooth curves without copying/warping a base-size curve across sizes.
    // In many graded DXFs, layer 14 is the net outline but may be low-resolution (few vertices).
    // Layers 81-87 often contain the same contour with much higher point density (curves).
    // We promote those curves for rendering and for generating seam/cut offsets.
    const DISPLAY_OUTLINE_CANDIDATE_LAYERS = new Set(["87", "86", "85", "84", "83", "82", "81"]);
    const countPoints = (paths: PolylinePath[]): number => (paths ?? []).reduce((sum, p) => sum + (p.points?.length ?? 0), 0);
    const isLikelySeamAllowanceBounds = (candidateBounds: Bounds, netBounds: Bounds): boolean => {
        // Heuristic: many CLO exports store seam/cutline as a ~10mm offset contour on layers 81-87.
        // That curve can have lots of points (high-res) but it must NOT be promoted as the *net* outline,
        // otherwise we would offset it again and end up with ~20mm.
        const netW = netBounds.maxX - netBounds.minX;
        const netH = netBounds.maxY - netBounds.minY;
        const candW = candidateBounds.maxX - candidateBounds.minX;
        const candH = candidateBounds.maxY - candidateBounds.minY;
        if (!(netW > 0) || !(netH > 0) || !(candW > 0) || !(candH > 0)) return false;

        const dw = candW - netW;
        const dh = candH - netH;
        if (!(dw > 0) || !(dh > 0)) return false;

        const expected = 2 * OUTLINE_MARGIN_MM;
        const tol = 6; // mm tolerance (exports can be slightly irregular)
        return Math.abs(dw - expected) <= tol && Math.abs(dh - expected) <= tol;
    };
    const boundsMismatch = (a: Bounds, b: Bounds): number => {
        const aw = a.maxX - a.minX;
        const ah = a.maxY - a.minY;
        const bw = b.maxX - b.minX;
        const bh = b.maxY - b.minY;
        if (!(aw > 0) || !(ah > 0) || !(bw > 0) || !(bh > 0)) return Infinity;
        const sx = bw / aw;
        const sy = bh / ah;
        const sizeScore = Math.max(Math.abs(1 - sx), Math.abs(1 - sy));
        // Also consider positional drift, normalized by target size.
        const dx = (b.minX - a.minX) / bw;
        const dy = (b.minY - a.minY) / bh;
        const posScore = Math.max(Math.abs(dx), Math.abs(dy));
        return Math.max(sizeScore, posScore);
    };

    const pointToPathDistance = (point: Point, path: PolylinePath): number => {
        const points = path.points ?? [];
        if (points.length < 2) return Infinity;
        const segmentCount = path.closed ? points.length : points.length - 1;
        let best = Infinity;
        for (let i = 0; i < segmentCount; i += 1) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const length2 = dx * dx + dy * dy;
            const t = length2 > 1e-12
                ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2))
                : 0;
            best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
        }
        return best;
    };

    const uniquePointMarkerCenters = (paths: PolylinePath[]): Point[] => {
        const centers: Point[] = [];
        for (const path of paths ?? []) {
            if (path.marker !== "point" || !(path.points?.length > 0)) continue;
            if (!isTurnCurveMetadataLayer(path.layer)) continue;
            const center = {
                x: path.points.reduce((sum, point) => sum + point.x, 0) / path.points.length,
                y: path.points.reduce((sum, point) => sum + point.y, 0) / path.points.length,
            };
            // A DXF POINT is represented by two cross arms. Treat both as one
            // grading/control location.
            if (!centers.some((existing) => Math.hypot(existing.x - center.x, existing.y - center.y) <= 0.5)) {
                centers.push(center);
            }
        }
        return centers;
    };

    const candidateRespectsOutlineMarkers = (candidate: PolylinePath, info: BlockInfo): boolean => {
        const sourceOutlines = (info.outlinePaths ?? []).filter((path) => path.closed && (path.points?.length ?? 0) >= 3);
        if (!sourceOutlines.length) return true;

        const cutContours = (info.sourceSeamPaths ?? []).filter(path => path.closed && path.points.length >= 3);
        const markerCenters = uniquePointMarkerCenters(info.helperPaths ?? []);
        const supportedMarkers = markerCenters
            .map((point) => ({
                point,
                sourceDistance: Math.min(...sourceOutlines.map((outline) => pointToPathDistance(point, outline))),
                cutDistance: Math.min(...cutContours.map(cut => pointToPathDistance(point, cut))),
                sourceVertexDistance: Math.min(...sourceOutlines.flatMap(outline => outline.points.map(vertex =>
                    Math.hypot(vertex.x-point.x,vertex.y-point.y)))),
            }))
            // Curve POINT metadata can describe either cutting or sewing geometry.
            // A cutting-curve point may lie near a coarse sewing chord by chance;
            // it must not veto the detailed sewing curve. Keep actual sewing
            // control vertices authoritative even where both boundaries meet.
            .filter(({cutDistance, sourceVertexDistance}) => cutDistance > 0.001 || sourceVertexDistance <= 0.25)
            // Interior construction points are unrelated to the perimeter and
            // must not veto a legitimate smooth outline.
            .filter(({ sourceDistance }) => sourceDistance <= 3);

        // One nearby point can be incidental. Two or more perimeter controls
        // are a strong local signal and are more reliable than global bounds.
        if (supportedMarkers.length < 2) return true;

        return supportedMarkers.every(({ point, sourceDistance }) => {
            const candidateDistance = pointToPathDistance(point, candidate);
            return candidateDistance <= Math.max(2.2, sourceDistance + 0.5);
        });
    };

    const candidateContainsSourceVertices = (candidate: PolylinePath, info: BlockInfo): boolean => {
        const sourceVertices = (info.outlinePaths ?? [])
            .filter((path) => path.closed && (path.points?.length ?? 0) >= 3)
            .flatMap((path) => path.points ?? []);
        if (!sourceVertices.length || !(candidate.points?.length > 0)) return true;

        // A quality curve may legitimately bow between layer-14 control nodes,
        // but it must retain those nodes. This rejects a globally similar curve
        // from another grading/cutline family without rejecting real splines.
        return sourceVertices.every((sourcePoint) =>
            candidate.points.some((candidatePoint) =>
                Math.hypot(sourcePoint.x - candidatePoint.x, sourcePoint.y - candidatePoint.y) <= 0.25
            )
        );
    };

    const normalizedClosedForComparison = (path: PolylinePath): Point[] => {
        let points = normalizeClosedPts(path.points ?? []);
        if (points.length < 3) return [];
        if (polygonSignedArea(points) < 0) points = points.slice().reverse();

        let minX = Infinity;
        let minY = Infinity;
        for (const point of points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
        }
        const translated = points.map((point) => ({ x: point.x - minX, y: point.y - minY }));
        let anchor = 0;
        for (let i = 1; i < translated.length; i += 1) {
            const point = translated[i];
            const current = translated[anchor];
            if (point.x < current.x - 1e-6 || (Math.abs(point.x - current.x) <= 1e-6 && point.y < current.y - 1e-6)) {
                anchor = i;
            }
        }
        return anchor > 0 ? translated.slice(anchor).concat(translated.slice(0, anchor)) : translated;
    };

    const closedPathsMatchApartFromTranslation = (a: PolylinePath, b: PolylinePath, toleranceMm: number): boolean => {
        const aa = normalizedClosedForComparison(a);
        const bb = normalizedClosedForComparison(b);
        if (aa.length < 3 || aa.length !== bb.length) return false;
        for (let i = 0; i < aa.length; i += 1) {
            if (Math.hypot(aa[i].x - bb[i].x, aa[i].y - bb[i].y) > toleranceMm) return false;
        }
        return true;
    };

    const mainClosedPath = (paths: PolylinePath[]): PolylinePath | null => {
        const closed = (paths ?? []).filter((path) => path.closed && (path.points?.length ?? 0) >= 3);
        if (!closed.length) return null;
        return closed.reduce((best, path) => extentScore(path.points) > extentScore(best.points) ? path : best);
    };

    perPiece.forEach((pieceBlocks) => {
        for (const info of pieceBlocks) {
            const outlinePointCount = countPoints(info.outlinePaths);
            if (outlinePointCount < 3) continue;

            const candidates = (info.helperPaths ?? []).filter((p) =>
                Boolean(p.closed) &&
                (p.points?.length ?? 0) >= 3 &&
                p.marker !== "point" &&
                DISPLAY_OUTLINE_CANDIDATE_LAYERS.has(String(p.layer ?? "").trim())
            );
            if (!candidates.length) continue;

            const sourceOutlineArea = (info.outlinePaths ?? [])
                .filter((p) => p.closed && (p.points?.length ?? 0) >= 3)
                .reduce((sum, p) => sum + computePathArea(p), 0);
            let best: { p: PolylinePath; mismatch: number; areaMismatch: number; score: number; pts: number } | null = null;
            for (const p of candidates) {
                const pb = computeBounds([p]);
                if (!pb) continue;

                // Do not promote seam-allowance curves as the net outline.
                if (isLikelySeamAllowanceBounds(pb, info.outlineBounds)) continue;

                // Layers 81-87 are quality-curve candidates, not authoritative
                // grading geometry. A globally similar curve can still be the
                // wrong local contour (most visible on non-graded cuffs/belts).
                // Keep layer 14 when the replacement stops passing through the
                // source DXF's perimeter POINT controls.
                if (!candidateRespectsOutlineMarkers(p, info)) continue;
                if (!candidateContainsSourceVertices(p, info)) continue;

                const mismatch = boundsMismatch(pb, info.outlineBounds);
                const pts = p.points?.length ?? 0;
                const candidateArea = computePathArea(p);
                const areaMismatch = sourceOutlineArea > 1e-9 && candidateArea > 1e-9
                    ? Math.abs(Math.log(candidateArea / sourceOutlineArea))
                    : Infinity;
                const score = mismatch * 2 + areaMismatch;
                // Must match reasonably well. Geometry agreement is more
                // important than raw vertex count: layer 84 can be a quality
                // copy of layer 1, while layer 87 corresponds to layer 14.
                if (mismatch > 0.12) continue;
                if (
                    !best ||
                    score < best.score - 1e-6 ||
                    (Math.abs(score - best.score) <= 1e-6 && pts > best.pts)
                ) {
                    best = { p, mismatch, areaMismatch, score, pts };
                }
            }
            // If we found a better render curve, promote it.
            if (best && best.pts > Math.max(8, outlinePointCount + 2)) {
                const originalLayer = String(info.outlinePaths?.[0]?.layer ?? "14");
                info.renderOutlinePaths = [
                    {
                        ...best.p,
                        kind: "outline" as const,
                        layer: originalLayer,
                        semanticRole: "sewingLine" as const,
                    },
                ];

            }

            // Some ASTM quality-curve exports (including the supplied fixture)
            // use layer 84 as a smooth copy of the layer-1 piece boundary. Use
            // it only when its bounds and area agree with the actual layer 1.
            const sourceSeam = (info.seamPaths ?? [])
                .filter((p) => p.closed && (p.points?.length ?? 0) >= 3)
                .sort((a, b) => extentScore(b.points) - extentScore(a.points))[0];
            if (sourceSeam) {
                const sourceSeamBounds = computeBounds([sourceSeam]);
                const sourceSeamArea = computePathArea(sourceSeam);
                const quality84 = candidates
                    .filter((p) => String(p.layer ?? "").trim() === "84")
                    .map((p) => {
                        const bounds = computeBounds([p]);
                        const area = computePathArea(p);
                        const boundsError = bounds && sourceSeamBounds ? boundsMismatch(sourceSeamBounds, bounds) : Infinity;
                        const areaError = sourceSeamArea > 1e-9 && area > 1e-9
                            ? Math.abs(Math.log(area / sourceSeamArea))
                            : Infinity;
                        return { p, score: boundsError * 2 + areaError };
                    })
                    .filter((entry) => Number.isFinite(entry.score) && entry.score <= 0.03)
                    .sort((a, b) => a.score - b.score)[0];
                if (quality84) {
                    info.seamPaths = [{
                        ...quality84.p,
                        kind: "seam" as const,
                        layer: String(sourceSeam.layer ?? "1"),
                        semanticRole: "cutBoundary" as const,
                    }];
                }
            }

            // Do not draw candidate-layer closed curves as helpers (they are outlines/seam-allowance
            // in many exports). If promoted, they are drawn as the outline via renderOutlinePaths.
            info.helperPaths = (info.helperPaths ?? []).filter((p) => {
                if (p.marker === "point") return true;
                const layer = String(p.layer ?? "").trim();
                if (!DISPLAY_OUTLINE_CANDIDATE_LAYERS.has(layer)) return true;
                if (!p.closed || (p.points?.length ?? 0) < 3) return true;
                // Remove all closed candidate-layer curves from helpers.
                return false;
            });
        }
    });

    // A non-graded piece has the exact same authoritative layer-14 contour in
    // every size (the blocks may only be translated). Do not let independently
    // exported quality layers invent grading for such a family. They may be used
    // only when they are also identical across sizes; otherwise layer 14 wins.
    perPiece.forEach((pieceBlocks, pieceKey) => {
        if (pieceBlocks.length < 2) return;
        const rawMain = pieceBlocks.map((info) => mainClosedPath(info.outlinePaths));
        const rawReference = rawMain[0];
        const rawBounds = rawMain.map((path) => path ? computeBounds([path]) : null);
        const referenceBounds = rawBounds[0];
        const dimensionsAreInvariant = Boolean(
            referenceBounds &&
            rawBounds.every((bounds) => bounds &&
                Math.abs((bounds.maxX - bounds.minX) - (referenceBounds.maxX - referenceBounds.minX)) <= 0.05 &&
                Math.abs((bounds.maxY - bounds.minY) - (referenceBounds.maxY - referenceBounds.minY)) <= 0.05
            )
        );
        const contourIsInvariant = Boolean(
            rawReference &&
            rawMain.every((path) => path && closedPathsMatchApartFromTranslation(rawReference, path, 0.05))
        );
        if (!dimensionsAreInvariant || !contourIsInvariant) {
            return;
        }
        // Equal width/height alone is not evidence of an ungraded family: two
        // curved contours can share a bounding box while their shape changes.
        // Preserve source seams only when the complete authoritative contour
        // is identical apart from block translation.
        const renderedMain = pieceBlocks.map((info) => mainClosedPath(info.renderOutlinePaths ?? info.outlinePaths));
        const renderedReference = renderedMain[0];
        const renderFamilyIsInvariant = Boolean(
            renderedReference &&
            renderedMain.every((path) => path && closedPathsMatchApartFromTranslation(renderedReference, path, 0.25))
        );
        if (renderFamilyIsInvariant) return;

        for (const info of pieceBlocks) info.renderOutlinePaths = undefined;
    });

    // helper mismatch score
    function helperMismatchToOutline(info: BlockInfo): number {
        const nonPointHelpers = (info.helperPaths ?? []).filter((p) => p.marker !== "point");
        if (!nonPointHelpers.length) return Infinity;
        const hb = computeBounds(nonPointHelpers);
        if (!hb) return Infinity;

        const ow = info.outlineBounds.maxX - info.outlineBounds.minX;
        const oh = info.outlineBounds.maxY - info.outlineBounds.minY;
        const hw = hb.maxX - hb.minX;
        const hh = hb.maxY - hb.minY;

        if (hw <= 0 || hh <= 0 || ow <= 0 || oh <= 0) return Infinity;

        const sx = ow / hw;
        const sy = oh / hh;
        return Math.max(Math.abs(1 - sx), Math.abs(1 - sy));
    }

    // seam mismatch score (used to detect ungraded layer-1 curves)
    function seamMismatchToOutline(info: BlockInfo): number {
        const seamCandidates = (info.seamPaths ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        if (!seamCandidates.length) return Infinity;
        const sb = computeBounds(seamCandidates);
        if (!sb) return Infinity;

        const displayOutline = (info.renderOutlinePaths ?? info.outlinePaths) ?? info.outlinePaths;
        const db = computeBounds(displayOutline) ?? info.outlineBounds;

        const ow = db.maxX - db.minX;
        const oh = db.maxY - db.minY;
        const sw = sb.maxX - sb.minX;
        const sh = sb.maxY - sb.minY;
        if (!(ow > 0) || !(oh > 0) || !(sw > 0) || !(sh > 0)) return Infinity;

        const sx = ow / sw;
        const sy = oh / sh;
        const sizeMismatch = Math.max(Math.abs(1 - sx), Math.abs(1 - sy));

        const dx = Math.abs((sb.minX - db.minX) / ow);
        const dy = Math.abs((sb.minY - db.minY) / oh);
        const posMismatch = Math.max(dx, dy);

        return Math.max(sizeMismatch, posMismatch);
    }

    const helperMostlyInside = (hb: Bounds, ob: Bounds) => {
        const margin = 2;
        return (
            hb.minX >= ob.minX - margin &&
            hb.maxX <= ob.maxX + margin &&
            hb.minY >= ob.minY - margin &&
            hb.maxY <= ob.maxY + margin
        );
    };

    const MAX_ACCEPTABLE_MISMATCH = 0.05; // 5 %

    const computeClosedArea = (paths: PolylinePath[]): number => {
        const closed = (paths ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        if (!closed.length) return 0;
        return closed.reduce((sum, p) => sum + computePathArea(p), 0);
    };

    const detectBaseWithSeamAllowance = (pieceBlocks: BlockInfo[]): BlockInfo | null => {
        if (pieceBlocks.length < 2) return null;

        // NOTE: `manualBaseLabel` is a UI choice for helper-line reference.
        // It must NOT influence seam-allowance detection, otherwise selecting a base size
        // can incorrectly inset that size's outline (changing computed dimensions).

        const areaOf = (b: BlockInfo): number => {
            const area = computeClosedArea(b.outlinePaths);
            if (area > 0) return area;
            const w = b.outlineBounds.maxX - b.outlineBounds.minX;
            const h = b.outlineBounds.maxY - b.outlineBounds.minY;
            return Math.max(0, w) * Math.max(0, h);
        };

        const medianValue = (values: number[]): number | null => {
            const v = values.filter((x) => Number.isFinite(x) && x > 0).slice().sort((a, c) => a - c);
            if (!v.length) return null;
            return v[Math.floor(v.length / 2)] ?? null;
        };

        const improvesTowardMedianAfterInset = (candidate: BlockInfo): boolean => {
            const candArea = areaOf(candidate);
            if (!(candArea > 0)) return false;
            const others = pieceBlocks.filter((b) => b !== candidate).map(areaOf);
            const med = medianValue(others);
            if (!med) return false;

            // Candidate must be meaningfully larger than the group.
            if (!(candArea > med * 1.03)) return false;

            const inset = offsetClosedPolylines(candidate.outlinePaths, -OUTLINE_MARGIN_MM);
            if (!inset.length) return false;
            const insetArea = computeClosedArea(inset);
            if (!(insetArea > 0)) return false;

            const origErr = Math.abs(Math.log(candArea) - Math.log(med));
            const insetErr = Math.abs(Math.log(insetArea) - Math.log(med));
            return insetErr < origErr * 0.65;
        };

        // Strong signal: exactly one variant has seam layer geometry.
        const seamCount = pieceBlocks.map((b) => (b.seamPaths?.length ?? 0) > 0);
        const seamOn = seamCount.filter(Boolean).length;
        if (seamOn === 1) {
            const candidate = pieceBlocks[seamCount.findIndex(Boolean)] ?? null;
            if (!candidate) return null;
            // Only trust this signal when the candidate actually behaves like a seam-allowance outlier.
            return improvesTowardMedianAfterInset(candidate) ? candidate : null;
        }

        // Heuristic: find one outlier in outline area progression.
        const scored = pieceBlocks
            .map((b) => ({ b, area: areaOf(b) }))
            .filter((x) => Number.isFinite(x.area) && x.area > 0)
            .sort((a, c) => a.area - c.area);

        if (scored.length < 3) return null;

        const logs = scored.map((s) => Math.log(s.area));
        const diffs: number[] = [];
        for (let i = 0; i < logs.length - 1; i += 1) diffs.push(logs[i + 1] - logs[i]);
        const sortedDiffs = diffs.slice().sort((a, c) => a - c);
        const diffMedian = sortedDiffs[Math.floor(sortedDiffs.length / 2)] ?? 0;

        let bestGapIdx = -1;
        let bestDev = 0;
        for (let i = 0; i < diffs.length; i += 1) {
            const dev = Math.abs(diffs[i] - diffMedian);
            if (dev > bestDev) {
                bestDev = dev;
                bestGapIdx = i;
            }
        }

        // Require a clear outlier gap.
        if (!(bestDev > 0.12)) return null; // ~12% in log-space

        const candidateIdx = bestGapIdx + 1; // the larger element after the gap
        const candidate = scored[candidateIdx]?.b ?? null;
        if (!candidate) return null;

        // Verify: insetting candidate by 10mm should bring it closer to its neighbors.
        const inset = offsetClosedPolylines(candidate.outlinePaths, -OUTLINE_MARGIN_MM);
        if (!inset.length) return null;
        const insetArea = computeClosedArea(inset);
        if (!(insetArea > 0)) return null;

        const left = scored[candidateIdx - 1]?.area;
        const right = scored[candidateIdx + 1]?.area;
        const neighborMean = left && right ? Math.sqrt(left * right) : left ?? right ?? null;
        if (!neighborMean) return null;

        const origArea = scored[candidateIdx].area;
        const origErr = Math.abs(Math.log(origArea) - Math.log(neighborMean));
        const insetErr = Math.abs(Math.log(insetArea) - Math.log(neighborMean));

        // Need a meaningful improvement (and candidate should be the bigger one).
        if (!(origArea > neighborMean * 1.03)) return null;
        if (!(insetErr < origErr * 0.65)) return null;

        return candidate;
    };

    const applySeamAllowanceFixToPiece = (pieceBlocks: BlockInfo[]) => {
        if (pieceBlocks.length < 2) return;
        const baseWithSeam = detectBaseWithSeamAllowance(pieceBlocks);
        if (!baseWithSeam) return;

        // Preserve a numeric outline layer so the dashed outline logic still considers it.
        const originalLayer = String(baseWithSeam.outlinePaths?.[0]?.layer ?? "14");

        const inset = offsetClosedPolylines(baseWithSeam.outlinePaths, -OUTLINE_MARGIN_MM);
        if (!inset.length) return;
        const fixedOutline = inset.map((p) => ({
            ...p,
            kind: "outline" as const,
            layer: originalLayer,
        }));
        const bb = computeBounds(fixedOutline);
        if (!bb) return;

        baseWithSeam.outlinePaths = fixedOutline;
        baseWithSeam.outlineBounds = bb;
        baseWithSeam.area = (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
    };

    // Optional: seam-allowance correction. Disabled by default because it changes outline geometry.
    // If enabled, apply it before helper/marker propagation so transforms use final bounds.
    if (doFixSeamAllowance) {
        perPiece.forEach((pieceBlocks) => applySeamAllowanceFixToPiece(pieceBlocks));
    }

    // 1c) Detect a likely base size from POINT markers (notches).
    // Many graded exports include graded geometry but only one size carries the point markers;
    // prefer that as the helper base when the user did not choose one.
    const detectMarkerBaseLabel = (): string | null => {
        const markerCountBySize = new Map<string, number>();

        perPiece.forEach((pieceBlocks) => {
            for (const info of pieceBlocks) {
                const size = (info.sizeLabel ?? "").toLowerCase();
                if (!size) continue;
                const markers = (info.helperPaths ?? []).filter((p) => p.marker === "point").length;
                if (!markers) continue;
                markerCountBySize.set(size, (markerCountBySize.get(size) ?? 0) + markers);
            }
        });

        const withMarkers = Array.from(markerCountBySize.entries()).filter(([, c]) => c > 0);
        if (withMarkers.length !== 1) return null;
        return withMarkers[0][0];
    };

    const autoMarkerBaseLabel = detectMarkerBaseLabel();

    // 2) Helper propagation / repair
    // Many graded exports contain helper construction lines on layers 6-10. Some sizes may contain
    // duplicated/misgraded helpers (e.g. 4 parallel lines instead of 2). Also, DXF POINT entities
    // (rendered as tiny crosses) often appear only in the base size but are required for all sizes.
    //
    // We use the chosen helper-base size (or a deterministic fallback) and map its helpers into
    // each size using an affine transform derived from outline bounds.
    const disableHelperPropagation = Boolean(options?.disableHelperPropagation);
    if (!disableHelperPropagation) {
        const HELPER_FIX_LAYERS = new Set(["6", "7", "8", "9", "10"]);

        const pointCenterKey = (p: PolylinePath): string => {
            const pts = p.points ?? [];
            if (p.marker !== "point" || pts.length < 2) return "";
            const cx = (pts[0].x + pts[pts.length - 1].x) / 2;
            const cy = (pts[0].y + pts[pts.length - 1].y) / 2;
            // Include the source layer so turn/curve metadata and physical
            // notches at the same coordinate remain separate categories.
            const layer = normalizeDxfLayer(p.layer);
            return `pt:${layer}:${Math.round(cx * 10) / 10},${Math.round(cy * 10) / 10}`;
        };

        const polylineTotalLength = (pts: Point[], closed: boolean): number => {
            const n = pts.length;
            if (n < 2) return 0;
            let total = 0;
            const segCount = closed ? n : n - 1;
            for (let i = 0; i < segCount; i += 1) {
                const a = pts[i];
                const b = pts[(i + 1) % n];
                total += Math.hypot(b.x - a.x, b.y - a.y);
            }
            return total;
        };


        const mapClosestPointToTarget = (
            corr: OutlineCorrespondence,
            p: Point
        ): { base: { q: Point; segIdx: number; t: number; nx: number; ny: number }; target: { q: Point; nx: number; ny: number; tx: number; ty: number } } | null => {
            const hit = closestPointOnPolyline(p, corr.basePts, true);
            if (!hit) return null;
            const n = corr.targetPts.length;
            const a = corr.targetPts[(hit.segIdx + corr.shift) % n];
            const b = corr.targetPts[(hit.segIdx + 1 + corr.shift) % n];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const qx = a.x + Math.max(0, Math.min(1, hit.t)) * dx;
            const qy = a.y + Math.max(0, Math.min(1, hit.t)) * dy;
            const nx = -dy / len;
            const ny = dx / len;
            // Keep the same local-frame convention used elsewhere: tx/ty is -tangent.
            const tx = -ny;
            const ty = nx;
            return {
                base: hit,
                target: { q: { x: qx, y: qy }, nx, ny, tx, ty },
            };
        };

        perPiece.forEach((pieceBlocks, pieceKey) => {
            if (pieceBlocks.length < 2) return;

            // Choose base block
            let base: BlockInfo | null = null;
            if (manualBaseLabel) {
                base = pieceBlocks.find((b) => (b.sizeLabel ?? "").toLowerCase() === manualBaseLabel) ?? null;
            }
            const didUseManualBase = Boolean(
                forceHelperBasePropagation &&
                manualBaseLabel &&
                base &&
                (base.sizeLabel ?? "").toLowerCase() === manualBaseLabel
            );
            if (!base && autoMarkerBaseLabel) {
                base = pieceBlocks.find((b) => (b.sizeLabel ?? "").toLowerCase() === autoMarkerBaseLabel) ?? null;
            }
            if (!base) {
                const sorted = pieceBlocks.slice().sort((a, b) => {
                    const ra = sizeRank(a.sizeLabel);
                    const rb = sizeRank(b.sizeLabel);
                    if (ra !== rb) return ra - rb;
                    // tie-breaker: use original alphabetical order of block names (more deterministic)
                    return a.name.localeCompare(b.name);
                });
                base = sorted[0] ?? null;
            }
            if (!base) return;

            const baseBounds = base.outlineBounds;
            const baseW = baseBounds.maxX - baseBounds.minX;
            const baseH = baseBounds.maxY - baseBounds.minY;
            if (!(baseW > 1e-6) || !(baseH > 1e-6)) return;

            const baseHelperFix = (base.helperPaths ?? []).filter((p) => {
                if (p.marker === "point") return false;
                const layer = String(p.layer ?? "").trim();
                return HELPER_FIX_LAYERS.has(layer);
            });
            // Preserve point categories independently. Layers 2/3 are internal
            // grading metadata; layer 4 remains physical notch information.
            const basePointMarkers = (base.helperPaths ?? []).filter((p) => p.marker === "point");
            const basePointGroups = new Map<string, PolylinePath[]>();
            for (const p of basePointMarkers) {
                const k = pointCenterKey(p);
                if (!k) continue;
                const list = basePointGroups.get(k);
                if (list) list.push(p);
                else basePointGroups.set(k, [p]);
            }

            baseInfoByPiece.set(pieceKey, {
                baseSize: base.sizeLabel ?? null,
                baseName: base.name,
                helpers: (base.helperPaths ?? []).length,
            });

            for (const info of pieceBlocks) {
                if (info === base) continue;
                const targetBounds = info.outlineBounds;
                const targetW = targetBounds.maxX - targetBounds.minX;
                const targetH = targetBounds.maxY - targetBounds.minY;
                if (!(targetW > 1e-6) || !(targetH > 1e-6)) continue;

                const t = {
                    sx: targetW / baseW,
                    sy: targetH / baseH,
                    tx: targetBounds.minX - baseBounds.minX * (targetW / baseW),
                    ty: targetBounds.minY - baseBounds.minY * (targetH / baseH),
                };

                const baseOutline = pickMainClosedOutline(base);
                const targetOutline = pickMainClosedOutline(info);
                const corr = baseOutline && targetOutline ? buildOutlineCorrespondence(baseOutline.points, targetOutline.points) : null;
                const baseCanon = !corr && baseOutline ? canonicalizeClosedOutline(baseOutline.points) : null;
                const targetCanon = !corr && targetOutline ? canonicalizeClosedOutline(targetOutline.points) : null;

                const mapPointByOutline = (p: Point): { q: Point; tx: number; ty: number; nx: number; ny: number } | null => {
                    if (corr) {
                        const mapped = mapClosestPointToTarget(corr, p);
                        if (!mapped) return null;
                        return {
                            q: mapped.target.q,
                            tx: mapped.target.tx,
                            ty: mapped.target.ty,
                            nx: mapped.target.nx,
                            ny: mapped.target.ny,
                        };
                    }
                    if (!baseCanon || !targetCanon) return null;
                    const hit = closestPointOnPolyline(p, baseCanon.pts, true);
                    if (!hit) return null;

                    const a = baseCanon.pts[hit.segIdx];
                    const b = baseCanon.pts[(hit.segIdx + 1) % baseCanon.pts.length];
                    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
                    const s = (baseCanon.cum[hit.segIdx] ?? 0) + (Math.max(0, Math.min(1, hit.t)) * segLen);
                    const frac = s / baseCanon.total;
                    const tp = pointAtArcFraction(targetCanon, frac);
                    if (!tp) return null;
                    const tx = -tp.ny;
                    const ty = tp.nx;
                    return { q: tp.p, tx, ty, nx: tp.nx, ny: tp.ny };
                };

                const isMarkerLikeHelper = (path: PolylinePath): boolean => {
                    if (!path || path.marker === "point") return false;
                    const pts = path.points ?? [];
                    if (path.closed) return false;
                    if (pts.length < 2 || pts.length > 6) return false;
                    const totalLen = polylineTotalLength(pts, false);
                    // Notches/markers are typically short segments near the outline/seam allowance.
                    if (!(totalLen > 0.1 && totalLen <= 35)) return false;
                    if (!baseCanon && !corr) return true; // will fall back to affine anyway
                    const center = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
                    const c = { x: center.x / pts.length, y: center.y / pts.length };
                    const hit = closestPointOnPolyline(c, (corr ? corr.basePts : baseCanon!.pts), true);
                    if (!hit) return false;
                    const d = Math.hypot(c.x - hit.q.x, c.y - hit.q.y);
                    // Allow seam allowance distance + a bit of slack.
                    return d <= 35;
                };

                const transformHelperPath = (path: PolylinePath, opts?: { forceOutlineFrame?: boolean }): PolylinePath => {
                    // Default affine transform (fast, OK for large construction lines)
                    const affine = () => transformPath(path, t);

                    const forceOutlineFrame = Boolean(opts?.forceOutlineFrame);
                    const shouldUseOutlineFrame = forceOutlineFrame || isMarkerLikeHelper(path);
                    if (!shouldUseOutlineFrame) return affine();
                    if ((!baseCanon || !targetCanon) && !corr) return affine();

                    const pts = path.points ?? [];
                    if (pts.length < 2) return affine();

                    const distToLine = (a: Point, b: Point, p: Point): number => {
                        const abx = b.x - a.x;
                        const aby = b.y - a.y;
                        const ab2 = abx * abx + aby * aby;
                        if (ab2 <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
                        const t0 = ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2;
                        const tClamped = Math.max(0, Math.min(1, t0));
                        const qx = a.x + tClamped * abx;
                        const qy = a.y + tClamped * aby;
                        return Math.hypot(p.x - qx, p.y - qy);
                    };

                    const isStraightPolyline = (pnts: Point[]): boolean => {
                        if (pnts.length <= 2) return true;
                        const a = pnts[0];
                        const b = pnts[pnts.length - 1];
                        const abLen = Math.hypot(b.x - a.x, b.y - a.y);
                        if (abLen <= 1e-6) return false;
                        // Helper lines are in mm-space; allow a small deviation.
                        const eps = 0.25;
                        let maxD = 0;
                        for (let i = 1; i < pnts.length - 1; i += 1) {
                            const d = distToLine(a, b, pnts[i]);
                            if (d > maxD) maxD = d;
                            if (maxD > eps) return false;
                        }
                        return true;
                    };

                    const mapPointWithOutlineFrame = (p: Point): Point | null => {
                        const basePts = corr ? corr.basePts : baseCanon!.pts;
                        const hit = closestPointOnPolyline(p, basePts, true);
                        if (!hit) return null;

                        // Base local frame at the hit segment.
                        const baseTx = -hit.ny;
                        const baseTy = hit.nx;

                        // Map the hit point to the target outline with the SAME segment index + t.
                        let mapped: { q: Point; tx: number; ty: number; nx: number; ny: number } | null = null;
                        if (corr) {
                            const n = corr.targetPts.length;
                            const a = corr.targetPts[(hit.segIdx + corr.shift) % n];
                            const b = corr.targetPts[(hit.segIdx + 1 + corr.shift) % n];
                            const dx = b.x - a.x;
                            const dy = b.y - a.y;
                            const len = Math.hypot(dx, dy) || 1;
                            const tt = Math.max(0, Math.min(1, hit.t));
                            const qx = a.x + tt * dx;
                            const qy = a.y + tt * dy;
                            const nx = -dy / len;
                            const ny = dx / len;
                            const tx = -ny;
                            const ty = nx;
                            mapped = { q: { x: qx, y: qy }, tx, ty, nx, ny };
                        } else {
                            // Fallback: use arc-length fraction based on the hit segment.
                            const canon = baseCanon!;
                            const a = canon.pts[hit.segIdx];
                            const b = canon.pts[(hit.segIdx + 1) % canon.pts.length];
                            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
                            const s = (canon.cum[hit.segIdx] ?? 0) + (Math.max(0, Math.min(1, hit.t)) * segLen);
                            const frac = s / canon.total;
                            const tp = pointAtArcFraction(targetCanon!, frac);
                            if (!tp) return null;
                            const tx = -tp.ny;
                            const ty = tp.nx;
                            mapped = { q: tp.p, tx, ty, nx: tp.nx, ny: tp.ny };
                        }

                        if (!mapped) return null;

                        // Decompose vector from outline to the point in (tangent, normal) and apply it.
                        const vx = p.x - hit.q.x;
                        const vy = p.y - hit.q.y;
                        const u = vx * baseTx + vy * baseTy;
                        const v = vx * hit.nx + vy * hit.ny;
                        return {
                            x: mapped.q.x + u * mapped.tx + v * mapped.nx,
                            y: mapped.q.y + u * mapped.ty + v * mapped.ny,
                        };
                    };

                    // Straight construction helpers remain straight by mapping their own endpoints
                    // and interpolating intermediate vertices. Do not re-anchor them at unrelated
                    // outline intersections: an endpoint can itself be a marked control point.
                    if (!path.closed && isStraightPolyline(pts)) {
                        const a0 = pts[0];
                        const b0 = pts[pts.length - 1];
                        const a1 = mapPointWithOutlineFrame(a0);
                        const b1 = mapPointWithOutlineFrame(b0);
                        if (!a1 || !b1) return affine();

                        const abx = b0.x - a0.x;
                        const aby = b0.y - a0.y;
                        const ab2 = abx * abx + aby * aby;
                        const mappedPts = pts.map((p) => {
                            if (ab2 <= 1e-12) return { x: a1.x, y: a1.y };
                            const t0 = ((p.x - a0.x) * abx + (p.y - a0.y) * aby) / ab2;
                            const tClamped = Math.max(0, Math.min(1, t0));
                            return {
                                x: a1.x + tClamped * (b1.x - a1.x),
                                y: a1.y + tClamped * (b1.y - a1.y),
                            };
                        });
                        return { ...path, points: mappedPts };
                    }

                    // Curved/piecewise construction helpers contain grading control vertices.
                    // Map each vertex through the same local frame as POINT markers. Mapping the
                    // whole path from one centre anchor keeps it rigid and makes its vertices drift
                    // away from their markers as the outline changes between sizes.
                    const mappedPts = pts.map((p) => mapPointWithOutlineFrame(p));
                    if (mappedPts.some((p) => !p)) return affine();
                    return { ...path, points: mappedPts as Point[] };
                };

                // 1) Fix helper layers 6-10 by replacing them with the base version.
                if (baseHelperFix.length) {
                    const targetFixHelpers = (info.helperPaths ?? []).filter((p) => {
                        if (p.marker === "point") return false;
                        const layer = String(p.layer ?? "").trim();
                        return HELPER_FIX_LAYERS.has(layer);
                    });

                    // Forced base propagation repairs helper layers 6-10, except for
                    // drill-anchored native paths protected below. Automatic propagation preserves a size's
                    // native helpers even when its POINT metadata exists only on the base size.
                    // Otherwise valid grain lines are needlessly moved and shortened per grade.
                    const shouldReplace =
                        didUseManualBase ||
                        targetFixHelpers.length === 0 ||
                        (baseHelperFix.length > 0 && targetFixHelpers.length !== baseHelperFix.length);

                    if (shouldReplace) {
                        // A native closed construction path whose vertices coincide with
                        // layer-13 drill points is already consistent for this size. Mapping
                        // it from the base outline would detach it from those immutable points.
                        const isDrillAnchored = (path: PolylinePath, helpers: PolylinePath[]): boolean => {
                            if (!path.closed || path.points.length < 3) return false;
                            const drillCenters = helpers
                                .filter((p) => p.marker === "point" && normalizeDxfLayer(p.layer) === "13")
                                .map((p) => {
                                    const a = p.points[0];
                                    const b = p.points[p.points.length - 1];
                                    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                                });
                            return path.points.every((vertex) => drillCenters.some(
                                (center) => Math.hypot(vertex.x - center.x, vertex.y - center.y) <= 0.1
                            ));
                        };
                        const sameTopology = (a: PolylinePath, b: PolylinePath): boolean =>
                            normalizeDxfLayer(a.layer) === normalizeDxfLayer(b.layer) &&
                            a.closed === b.closed && a.points.length === b.points.length;
                        const anchoredBase = baseHelperFix.filter((p) => isDrillAnchored(p, base.helperPaths));
                        const anchoredTarget = targetFixHelpers.filter((p) => isDrillAnchored(p, info.helperPaths));
                        const preserved = new Set<PolylinePath>();
                        const replacedSources = new Set<PolylinePath>();
                        for (const native of anchoredTarget) {
                            const sources = anchoredBase.filter((p) => sameTopology(p, native));
                            // Only pair unambiguous paths; otherwise retain the existing repair behavior.
                            if (sources.length !== 1 || anchoredTarget.filter((p) => sameTopology(p, native)).length !== 1) continue;
                            preserved.add(native);
                            replacedSources.add(sources[0]);
                        }
                        const kept = (info.helperPaths ?? []).filter((p) => {
                            if (preserved.has(p)) return true;
                            if (p.marker === "point") return true;
                            const layer = String(p.layer ?? "").trim();
                            return !HELPER_FIX_LAYERS.has(layer);
                        });
                        // Use outline-local frame mapping so long helpers don’t get scaled.
                        const mapped = baseHelperFix
                            .filter((p) => !replacedSources.has(p))
                            .map((p) => transformHelperPath(p, { forceOutlineFrame: true }));
                        info.helperPaths = [...kept, ...mapped];
                    }
                }

                // 2) Ensure POINT data exists in all sizes, layer by layer.
                // IMPORTANT: each DXF POINT is represented by *two* short line segments (a cross).
                // We must not dedupe at the segment level, otherwise we end up with a single tick.
                if (basePointGroups.size) {
                    const existingPointSegs = (info.helperPaths ?? []).filter((p) => p.marker === "point");
                    const existingPointLayers = new Set(
                        existingPointSegs.map((p) => normalizeDxfLayer(p.layer))
                    );
                    const missingPointGroups = Array.from(basePointGroups.values()).filter((segs) => {
                        const sourceLayer = normalizeDxfLayer(segs[0]?.layer);
                        return !existingPointLayers.has(sourceLayer);
                    });
                    if (!missingPointGroups.length) continue;

                    const mapCenterAlongOutline = (baseCenter: Point): Point | null => {
                        if (corr) {
                            const mapped = mapClosestPointToTarget(corr, baseCenter);
                            if (!mapped) {
                                return { x: baseCenter.x * t.sx + t.tx, y: baseCenter.y * t.sy + t.ty };
                            }
                            // Preserve the complete outline-local offset. Keeping only the
                            // normal component makes markers slide along corners/curves and
                            // detach from their construction helpers in another grade.
                            const baseTx = -mapped.base.ny;
                            const baseTy = mapped.base.nx;
                            const ox = baseCenter.x - mapped.base.q.x;
                            const oy = baseCenter.y - mapped.base.q.y;
                            const tangentOffset = ox * baseTx + oy * baseTy;
                            const normalOffset = ox * mapped.base.nx + oy * mapped.base.ny;
                            return {
                                x: mapped.target.q.x
                                    + tangentOffset * mapped.target.tx
                                    + normalOffset * mapped.target.nx,
                                y: mapped.target.q.y
                                    + tangentOffset * mapped.target.ty
                                    + normalOffset * mapped.target.ny,
                            };
                        }

                        if (!baseCanon || !targetCanon) {
                            // Fallback: simple affine mapping if outline param mapping isn't available.
                            return { x: baseCenter.x * t.sx + t.tx, y: baseCenter.y * t.sy + t.ty };
                        }
                        const hit = closestPointOnPolyline(baseCenter, baseCanon.pts, true);
                        if (!hit) return { x: baseCenter.x * t.sx + t.tx, y: baseCenter.y * t.sy + t.ty };

                        const a = baseCanon.pts[hit.segIdx];
                        const b = baseCanon.pts[(hit.segIdx + 1) % baseCanon.pts.length];
                        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
                        const s = (baseCanon.cum[hit.segIdx] ?? 0) + (Math.max(0, Math.min(1, hit.t)) * segLen);
                        const frac = s / baseCanon.total;

                        // Preserve both components of the local outline frame here too.
                        const baseTx = -hit.ny;
                        const baseTy = hit.nx;
                        const ox = baseCenter.x - hit.q.x;
                        const oy = baseCenter.y - hit.q.y;
                        const tangentOffset = ox * baseTx + oy * baseTy;
                        const normalOffset = ox * hit.nx + oy * hit.ny;

                        const tp = pointAtArcFraction(targetCanon, frac);
                        if (!tp) return { x: baseCenter.x * t.sx + t.tx, y: baseCenter.y * t.sy + t.ty };
                        const targetTx = -tp.ny;
                        const targetTy = tp.nx;
                        return {
                            x: tp.p.x + tangentOffset * targetTx + normalOffset * tp.nx,
                            y: tp.p.y + tangentOffset * targetTy + normalOffset * tp.ny,
                        };
                    };

                    const outMarkers: PolylinePath[] = [];
                    for (const segs of missingPointGroups) {
                        const first = segs[0];
                        const pts = first?.points ?? [];
                        if (pts.length < 2) continue;
                        const baseCenter = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 };
                        const mappedCenter = mapCenterAlongOutline(baseCenter);
                        if (!mappedCenter) continue;

                        for (const seg of segs) {
                            const segPts = seg.points ?? [];
                            if (segPts.length < 2) continue;
                            const mapped = {
                                ...seg,
                                points: segPts.map((p) => ({
                                    // Keep marker (cross) size constant in mm; only move its center.
                                    x: mappedCenter.x + (p.x - baseCenter.x),
                                    y: mappedCenter.y + (p.y - baseCenter.y),
                                })),
                            };
                            outMarkers.push(mapped);
                        }
                    }

                    info.helperPaths = [...(info.helperPaths ?? []), ...outMarkers];
                }
            }
        });
    }

    // 2a) Helper-line scaling correction removed (was unreliable and could distort grading).

    // 2b) Grade copied layer-1 cutting geometry from the real outline grading.
    //
    // ASTM exports can repeat one base cutting boundary in every size block
    // while layer 14 contains the actual graded geometry. Rendering those
    // repeated layer-1 paths directly makes only the base size correct.
    //
    // Detect that representation from invariant layer-1 dimensions plus
    // changing layer-14 dimensions. Transform the base cutting boundary with a
    // local displacement field derived from corresponding outline vertices.
    // Unlike nearest-segment projection, this field does not jump between
    // nearby branches on darts, notches, spirals, or other concave pieces.

    const pickLargestClosed = (paths: PolylinePath[]): PolylinePath | null => {
        const closed = (paths ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        if (!closed.length) return null;
        let best = closed[0];
        let bestScore = extentScore(best.points);
        for (let i = 1; i < closed.length; i += 1) {
            const s = extentScore(closed[i].points);
            if (s > bestScore) {
                best = closed[i];
                bestScore = s;
            }
        }
        return best;
    };

    const asCutBoundary = (path: PolylinePath): PolylinePath => ({
        ...path,
        points: (path.points ?? []).map((point) => ({ ...point })),
        kind: "seam",
        layer: "1",
        semanticRole: "cutBoundary",
    });

    const pathDimensions = (path: PolylinePath | null): { width: number; height: number } | null => {
        if (!path) return null;
        const pathBounds = computeBounds([path]);
        if (!pathBounds) return null;
        return {
            width: pathBounds.maxX - pathBounds.minX,
            height: pathBounds.maxY - pathBounds.minY,
        };
    };

    const pathSelfIntersects = (path: PolylinePath): boolean => {
        if (!path.closed) return false;
        const points = normalizeClosedPts(path.points ?? []);
        if (points.length < 4) return false;
        const cross = (a: Point, b: Point, c: Point) =>
            (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        const properlyIntersects = (a: Point, b: Point, c: Point, d: Point) => {
            const eps = 1e-7;
            const abC = cross(a, b, c);
            const abD = cross(a, b, d);
            const cdA = cross(c, d, a);
            const cdB = cross(c, d, b);
            return ((abC > eps && abD < -eps) || (abC < -eps && abD > eps)) &&
                ((cdA > eps && cdB < -eps) || (cdA < -eps && cdB > eps));
        };
        for (let first = 0; first < points.length; first += 1) {
            for (let second = first + 2; second < points.length; second += 1) {
                if (first === 0 && second === points.length - 1) continue;
                if (properlyIntersects(
                    points[first],
                    points[(first + 1) % points.length],
                    points[second],
                    points[(second + 1) % points.length]
                )) return true;
            }
        }
        return false;
    };

    const deformCutBoundaryFromOutlineGrading = (
        source: PolylinePath,
        baseOutline: PolylinePath,
        targetOutline: PolylinePath
    ): PolylinePath | null => {
        const correspondence = buildOutlineCorrespondence(
            baseOutline.points,
            targetOutline.points
        );
        if (!correspondence) return null;

        let sourcePoints = normalizeClosedPts(source.points ?? []);
        if (sourcePoints.length < 3) return null;
        if (polygonSignedArea(sourcePoints) < 0) {
            sourcePoints = sourcePoints.slice().reverse();
        }

        const pointCount = correspondence.basePts.length;
        if (pointCount < 3) return null;

        const points = sourcePoints.map((point): Point | null => {
            const hit = closestPointOnPolyline(
                point,
                correspondence.basePts,
                true
            );
            if (!hit) return null;
            const first = (
                hit.segIdx + correspondence.shift
            ) % pointCount;
            const second = (first + 1) % pointCount;
            const targetX =
                correspondence.targetPts[first].x +
                (
                    correspondence.targetPts[second].x -
                    correspondence.targetPts[first].x
                ) * hit.t;
            const targetY =
                correspondence.targetPts[first].y +
                (
                    correspondence.targetPts[second].y -
                    correspondence.targetPts[first].y
                ) * hit.t;
            return {
                x: point.x + targetX - hit.q.x,
                y: point.y + targetY - hit.q.y,
            };
        });
        if (points.some((point) =>
            !point ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y)
        )) return null;
        const result = asCutBoundary({
            ...source,
            points: points as Point[],
        });
        const sourceBoundary = asCutBoundary(source);
        return pathSelfIntersects(result) && !pathSelfIntersects(sourceBoundary)
            ? null
            : result;
    };

    perPiece.forEach((pieceBlocks) => {
        const mainCuts = pieceBlocks.map((info) =>
            pickLargestClosed(info.sourceSeamPaths ?? [])
        );
        const cutDimensions = mainCuts.map(pathDimensions);
        const outlineDimensions = pieceBlocks.map((info) =>
            pathDimensions(mainClosedPath(info.outlinePaths))
        );
        const outlineGradeBounds = pieceBlocks.map((info) => {
            const outline = mainClosedPath(info.outlinePaths);
            return outline ? computeBounds([outline]) : null;
        });
        const referenceCut = cutDimensions.find(
            (dimensions): dimensions is { width: number; height: number } =>
                Boolean(dimensions)
        ) ?? null;
        const validOutlineDimensions = outlineDimensions.filter(
            (dimensions): dimensions is { width: number; height: number } =>
                Boolean(dimensions)
        );
        const validOutlineGradeBounds = outlineGradeBounds.filter(
            (bounds): bounds is Bounds => Boolean(bounds)
        );
        const boundsSpread = (selector: (bounds: Bounds) => number) =>
            Math.max(...validOutlineGradeBounds.map(selector)) -
            Math.min(...validOutlineGradeBounds.map(selector));
        const outlineGeometryVaries = Boolean(
            validOutlineDimensions.length === pieceBlocks.length &&
            validOutlineGradeBounds.length === pieceBlocks.length &&
            (
                Math.max(...validOutlineDimensions.map((dimensions) => dimensions.width)) -
                    Math.min(...validOutlineDimensions.map((dimensions) => dimensions.width)) > 0.5 ||
                Math.max(...validOutlineDimensions.map((dimensions) => dimensions.height)) -
                    Math.min(...validOutlineDimensions.map((dimensions) => dimensions.height)) > 0.5 ||
                boundsSpread((bounds) => bounds.minX) > 0.5 ||
                boundsSpread((bounds) => bounds.minY) > 0.5 ||
                boundsSpread((bounds) => bounds.maxX) > 0.5 ||
                boundsSpread((bounds) => bounds.maxY) > 0.5
            )
        );
        const copiedCutFamily = Boolean(
            referenceCut &&
            cutDimensions.every((dimensions) =>
                dimensions &&
                Math.abs(dimensions.width - referenceCut.width) <= 0.25 &&
                Math.abs(dimensions.height - referenceCut.height) <= 0.25
            ) &&
            outlineGeometryVaries
        );

        if (!copiedCutFamily) {
            for (const info of pieceBlocks) {
                info.seamPaths = (info.sourceSeamPaths ?? []).map(asCutBoundary);
            }
            return;
        }

        const sorted = pieceBlocks.slice().sort((a, b) => {
            const aNumber = Number(a.sizeLabel);
            const bNumber = Number(b.sizeLabel);
            if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
                return aNumber - bNumber;
            }
            const rankDifference = sizeRank(a.sizeLabel) - sizeRank(b.sizeLabel);
            return rankDifference || a.name.localeCompare(b.name);
        });
        const manuallySelectedBase = forceHelperBasePropagation && manualBaseLabel
            ? pieceBlocks.find(
                (info) => (info.sizeLabel ?? "").toLowerCase() === manualBaseLabel
            ) ?? null
            : null;
        // For an even number of grades, ASTM base sizes conventionally use the
        // lower of the two middle sizes (e.g. 46 in 42-52).
        const base = manuallySelectedBase ??
            sorted[Math.max(0, Math.floor((sorted.length - 1) / 2))] ??
            null;
        // Layer 14 contains the authored grading control vertices. Layer 87 is
        // only its high-resolution validation/display representation and may
        // use a different tessellation count in individual sizes.
        const baseOutline = base ? mainClosedPath(base.outlinePaths) : null;
        const baseCuts = base?.sourceSeamPaths ?? [];

        for (const info of pieceBlocks) {
            if (!base || !baseOutline || !baseCuts.length || info === base) {
                info.seamPaths = (info.sourceSeamPaths ?? []).map(asCutBoundary);
                continue;
            }
            const targetOutline = mainClosedPath(info.outlinePaths);
            const graded = targetOutline
                ? baseCuts.map((path) =>
                    deformCutBoundaryFromOutlineGrading(
                        path,
                        baseOutline,
                        targetOutline
                    )
                )
                : [];
            if (
                graded.length === baseCuts.length &&
                graded.every((path): path is PolylinePath => Boolean(path))
            ) {
                info.seamPaths = graded;
            } else {
                // Never hide cutting geometry if a malformed export has no
                // reliable outline correspondence.
                info.seamPaths = (info.sourceSeamPaths ?? []).map(asCutBoundary);
            }
        }
    });

    // Explicit repairs are applied after normal import/grading. Keeping the source
    // entities intact prevents a repair from changing family detection for unselected sizes.
    perPiece.forEach((pieceBlocks) => {
        for (const info of pieceBlocks) {
            const replacement = blocks[info.name]?.repairedCutContour;
            if (replacement?.closed && replacement.points?.length >= 3) {
                info.seamPaths = [asCutBoundary(replacement)];
            }
        }
    });

    // Propagate missing annotations independently of construction-line repairs,
    // before size filtering so a hidden reference size remains available.
    perPiece.forEach((pieceBlocks) => {
        // Preserve case here: exports can name mirrored pieces "Rückteil" and
        // "rückteil". Their annotations must not migrate to the opposite side.
        const families = new Map<string, BlockInfo[]>();
        for (const info of pieceBlocks) {
            const family = families.get(info.pieceLabel) ?? [];
            family.push(info);
            families.set(info.pieceLabel, family);
        }
        for (const family of families.values()) {
            const sources = family.filter((info) => info.annotations.length > 0);
            const preferredLabel = manualBaseLabel ?? autoMarkerBaseLabel;
            const source = sources.find((info) => info.sizeLabel?.toLowerCase() === preferredLabel) ??
                sources.slice().sort((a, b) => b.annotations.length - a.annotations.length || a.name.localeCompare(b.name))[0];
            if (!source) continue;
            const base = source.outlineBounds;
            const baseWidth = base.maxX - base.minX;
            const baseHeight = base.maxY - base.minY;
            if (!(baseWidth > 0 && baseHeight > 0)) continue;
            const key = (annotation: DxfAnnotation) =>
                `${annotation.layer}:${annotation.text.trim().replace(/\s+/g, " ").toLowerCase()}`;
            for (const target of family) {
                if (target === source) continue;
                const bounds = target.outlineBounds;
                const width = bounds.maxX - bounds.minX;
                const height = bounds.maxY - bounds.minY;
                if (!(width > 0 && height > 0)) continue;
                const existingCounts = new Map<string, number>();
                for (const annotation of target.annotations) {
                    const id = key(annotation);
                    existingCounts.set(id, (existingCounts.get(id) ?? 0) + 1);
                }
                for (const annotation of source.annotations) {
                    const id = key(annotation);
                    const count = existingCounts.get(id) ?? 0;
                    if (count > 0) {
                        existingCounts.set(id, count - 1);
                        continue;
                    }
                    target.annotations.push({
                        ...annotation,
                        position: {
                            x: bounds.minX + (annotation.position.x - base.minX) * width / baseWidth,
                            y: bounds.minY + (annotation.position.y - base.minY) * height / baseHeight,
                        },
                    });
                }
            }
        }
    });

    // 3) Build DrawableBlock[]
    const result: DrawableBlock[] = [];

    // Packing must cover every visible physical contour. Bounding-box
    // containment is insufficient for concave pieces: layer 14 can protrude
    // through a notch or inner curve while remaining inside layer 1's AABB.
    const pickPackGeometry = (info: BlockInfo): { packPaths: PolylinePath[]; packBounds: Bounds } => {
        const outlineBounds = info.outlineBounds;
        const seamClosed = (info.seamPaths ?? []).filter((p) => p.closed && (p.points?.length ?? 0) >= 3);
        const seamBest = pickLargestClosed(seamClosed);
        if (!seamBest) return { packPaths: info.outlinePaths, packBounds: outlineBounds };

        const seamBounds = computeBounds(seamClosed);
        if (!seamBounds) return { packPaths: info.outlinePaths, packBounds: outlineBounds };

        const renderedOutlines = (info.renderOutlinePaths ?? info.outlinePaths)
            .filter((path) => path.closed && (path.points?.length ?? 0) >= 3);
        const combinedPaths = [...seamClosed, ...renderedOutlines];
        const combinedBounds = computeBounds(combinedPaths) ?? seamBounds;

        return {
            packPaths: combinedPaths,
            packBounds: combinedBounds,
        };
    };

    // NOTE: We intentionally do NOT warp outlines using ungraded layer "1" curves.
    // In graded ASTM DXFs this can make every size look like the base size.

    perPiece.forEach((pieceBlocks) => {
        for (const info of pieceBlocks) {
            const { name, pieceLabel, sizeLabel, outlineBounds, groupId } = info;

            if (sizeFilters && (!sizeLabel || !sizeFilters.has(sizeLabel))) continue; // filter output after helper propagation

            // Construction/helper entities occasionally extend beyond the
            // graded piece in the source DXF (notably layer 8 in teeest.dxf).
            // Keep raw parsing lossless, but never render/export open helpers
            // outside the actual layer-14 piece boundary. POINT markers remain
            // un-clipped because their center or cross arms may intentionally
            // sit on either side of an edge.
            const helperClipContour = pickLargestClosed(info.renderOutlinePaths ?? info.outlinePaths ?? []) ??
                pickMainClosedOutline(info);
            const normalizedHelperPaths = (info.helperPaths ?? []).map(normalizeFabricDirectionPath);
            const renderableHelpers = helperClipContour
                ? normalizedHelperPaths.flatMap((p) =>
                    p.marker === "point" ||
                    p.closed ||
                    normalizeDxfLayer(p.layer) === "7"
                        ? [p]
                        : clipOpenPathToClosedPolygon(p, helperClipContour.points)
                )
                : normalizedHelperPaths;
            const physicalContours: PolylinePath[] = [
                ...(info.renderOutlinePaths ?? info.outlinePaths),
                ...info.seamPaths,
            ];
            const essentialPointData = renderableHelpers.filter((path) => path.marker === "point");
            const renderPaths: PolylinePath[] = includeHelpers
                ? [...physicalContours, ...renderableHelpers]
                : [...physicalContours, ...essentialPointData];

            // Packing should ignore helpers entirely and should use the outer cutline when available.
            const { packPaths, packBounds } = pickPackGeometry(info);

            result.push({
                name,
                pieceLabel,
                sizeLabel,
                groupId,
                polyType: info.polyType,
                rotationStepOverride: info.rotationStepOverride,
                paths: renderPaths,
                annotations: info.annotations,
                packPaths,
                bounds: packBounds,
                outlineBounds,
                width: packBounds.maxX - packBounds.minX,
                height: packBounds.maxY - packBounds.minY,
            });

            if (debug) {
                const baseInfo = baseInfoByPiece.get(pieceLabel.toLowerCase());
                const outlineW = outlineBounds.maxX - outlineBounds.minX;
                const outlineH = outlineBounds.maxY - outlineBounds.minY;
                debugRows.push({
                    piece: pieceLabel,
                    size: sizeLabel ?? "(none)",
                    baseSize: baseInfo?.baseSize ?? null,
                    baseName: baseInfo?.baseName ?? null,
                    baseHelpers: baseInfo?.helpers ?? 0,
                    appliedHelpers: renderPaths.filter((p) => p.kind === "helper").length,
                    outlineSize: `${outlineW.toFixed(1)}x${outlineH.toFixed(1)}`,
                });
            }
        }
    });

    if (debug && debugRows.length) {
        console.table(debugRows);
    }

    return result.sort((a, b) => b.width * b.height - a.width * a.height);
}





// --- Canvas rendering ---
export function getCurrentViewMetrics(
    canvas: HTMLCanvasElement,
    container: HTMLDivElement,
    fabricWidth: number,
    usedHeight: number,
    deviceRatio: number
) {
    const cssW = container.clientWidth || 1500;
    const cssH = container.clientHeight || 600;
    const margin = PAGE_MARGIN;
    // Fit width to container minus margins
    const availableW = Math.max(cssW - margin * 2, 100);
    // Return CSS-space scale; drawing code will apply DPR transform.
    const scale = availableW / Math.max(fabricWidth, 1);
    // Viewer behavior: canvas fixed to container, we pan/zoom internally without expanding
    const desiredH = cssH;

    const dpr = deviceRatio || 1;
    const targetWidth = Math.max(1, Math.floor(cssW * dpr));
    const targetHeight = Math.max(1, Math.floor(desiredH * dpr));
    if (canvas.width !== targetWidth) {
        canvas.width = targetWidth;
    }
    if (canvas.height !== targetHeight) {
        canvas.height = targetHeight;
    }
    const widthPx = `${cssW}px`;
    const heightPx = `${desiredH}px`;
    if (canvas.style.width !== widthPx) {
        canvas.style.width = widthPx;
    }
    if (canvas.style.height !== heightPx) {
        canvas.style.height = heightPx;
    }

    const originX = margin;
    const originY = margin;

    return { scale, originX, originY };
}

export function drawCanvas(
    canvas: HTMLCanvasElement | null,
    container: HTMLDivElement | null,
    placements: PlacedDrawableBlock[],
    usedHeight: number,
    fabricWidth: number,
    deviceRatio: number,
    zoom: number,
    pan: { x: number; y: number },
    visibleLayers?: Set<string> | null,
    showText?: boolean,
    showBoundingBoxes?: boolean,
    labelHeightMm?: number,
    outlineMarginMm?: number,
    useRealBounding?: boolean,
    pltOverlay?: { paths: Point[][] } | null,
    showGradingMetadataPoints?: boolean
) {
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { scale, originX, originY } = getCurrentViewMetrics(canvas, container, fabricWidth, usedHeight, deviceRatio);
    const dpr = deviceRatio || 1;

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Always start from a white background (important for overlap / exports / screenshots)
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Apply DPR transform so subsequent drawing uses CSS-space coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Fabric area
    ctx.save();
    // Apply origin, then pan, then zoom
    const totalScale = scale * zoom;
    ctx.translate(originX + pan.x, originY + pan.y);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#cfd7de";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(0, 0, fabricWidth * totalScale, Math.max(usedHeight, 1) * totalScale);
    ctx.fill();
    ctx.stroke();

    // Grid (every 100mm)
    ctx.strokeStyle = "#e6ebf0";
    ctx.lineWidth = 1;
    for (let x = 100; x < fabricWidth; x += 100) {
        ctx.beginPath();
        ctx.moveTo(x * totalScale, 0);
        ctx.lineTo(x * totalScale, Math.max(usedHeight, 1) * totalScale);
        ctx.stroke();
    }

    // PLT/HPGL overlay (background reference)
    if (pltOverlay?.paths?.length) {
        ctx.save();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.35)";
        ctx.lineWidth = 1;
        for (const path of pltOverlay.paths) {
            if (!path || path.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(path[0].x * totalScale, path[0].y * totalScale);
            for (let i = 1; i < path.length; i += 1) {
                const pt = path[i];
                ctx.lineTo(pt.x * totalScale, pt.y * totalScale);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // Draw pieces
    for (const p of placements) {
        drawPlacedPiece(
            ctx,
            p,
            totalScale,
            visibleLayers,
            Boolean(showText),
            Boolean(showBoundingBoxes),
            labelHeightMm,
            Math.max(0, outlineMarginMm ?? 0),
            Boolean(useRealBounding),
            Boolean(showGradingMetadataPoints)
        );
    }

    ctx.restore();
}

export function drawPlacedPiece(
    ctx: CanvasRenderingContext2D,
    p: PlacedDrawableBlock,
    scale: number,
    visibleLayers?: Set<string> | null,
    showText: boolean = true,
    showBoundingBoxes: boolean = false,
    labelHeightMm: number = 10,
    outlineMarginMm: number = 0,
    useRealBounding: boolean = false,
    showGradingMetadataPoints: boolean = false
) {

    const offX = p.x * scale;
    const offY = p.y * scale;
    const renderBounds = p.variant.renderBounds ?? p.variant.bounds;
    let clipBounds = p.variant.bounds;

    const pickLargestClosed = (paths: PolylinePath[]): PolylinePath | null => {
        const closed = (paths ?? []).filter((pp) => pp.closed && (pp.points?.length ?? 0) >= 3);
        if (!closed.length) return null;
        let best = closed[0];
        let bestScore = extentScore(best.points);
        for (let i = 1; i < closed.length; i += 1) {
            const s = extentScore(closed[i].points);
            if (s > bestScore) {
                best = closed[i];
                bestScore = s;
            }
        }
        return best;
    };

    const filterUsableOuterSeams = (seams: PolylinePath[], outlineReference: PolylinePath | null): PolylinePath[] => {
        if (!outlineReference) return seams;
        return seams.filter((sp) => {
            const sb = computeBounds([sp]);
            const ob = computeBounds([outlineReference]);
            if (!sb || !ob) return false;
            const tol = 0.5;
            const containsOutline =
                sb.minX <= ob.minX + tol &&
                sb.maxX >= ob.maxX - tol &&
                sb.minY <= ob.minY + tol &&
                sb.maxY >= ob.maxY - tol;
            if (!containsOutline) return false;
            const seamArea = computePathArea(sp);
            const outlineArea = computePathArea(outlineReference);
            if (outlineArea > 0 && seamArea > 0 && seamArea < outlineArea * 0.995) return false;
            return true;
        });
    };

    // Outline
    ctx.save();
    ctx.translate(offX, offY);

    if (outlineMarginMm > 0) {
        ctx.save();
        ctx.strokeStyle = "rgba(0, 120, 212, 0.9)";
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1;

        // Important: draw outline in the same coordinate system as the rendered piece.
        // Re-anchoring to "padded" bounds causes the offset distance to become uneven.
        const base = renderBounds;

        // A missing cut boundary may be derived from the internal sewing/quality
        // contour even when that contour is not physically visible.
        const isEligible = (path: PolylinePath) => {
            const layer = String(path.layer ?? "").trim();
            const n = layer ? Number(layer) : NaN;
            if (!Number.isFinite(n)) return false;
            if (!(n === 14 || n > 80)) return false;
            return true;
        };

        const renderPaths = (p.variant.paths ?? []) as PolylinePath[];
        let eligible: PolylinePath[] = renderPaths.filter(isEligible);
        if (!eligible.length) {
            const packPaths = (((p.variant as any).packPaths ?? []) as PolylinePath[]) || [];
            eligible = packPaths.filter(isEligible);
        }

        const outlineReference = pickLargestClosed(eligible);

        const seamCandidates = renderPaths.filter((pp) => {
            if (!pp.closed || (pp.points?.length ?? 0) < 3) return false;
            const layer = String(pp.layer ?? "").trim();
            return pp.kind === "seam" || layer === "1";
        });
        const seamToDraw = pickLargestClosed(filterUsableOuterSeams(seamCandidates, outlineReference));

        if (!seamToDraw) {
            // Only synthesize a cutting boundary when layer 1 is absent. A
            // native layer-1 path is rendered once in the physical path pass.
            const toOffset = pickLargestClosed(eligible);
            if (toOffset) {
                const offsetPaths = offsetClosedPolylines([toOffset], outlineMarginMm);
                for (const path of offsetPaths) {
                    if (!path.points.length) continue;
                    ctx.beginPath();
                    const start = path.points[0];
                    ctx.moveTo((start.x - base.minX) * scale, (start.y - base.minY) * scale);
                    for (let i = 1; i < path.points.length; i += 1) {
                        const pt = path.points[i];
                        ctx.lineTo((pt.x - base.minX) * scale, (pt.y - base.minY) * scale);
                    }
                    ctx.closePath();
                    ctx.stroke();
                }
            }
        }
        ctx.restore();
    }

    // When an outline margin is enabled, packing/collision typically uses the enlarged (calculated) outline.
    // Clip against that enlarged outline's AABB so helpers/markers inside it remain visible.
    if (outlineMarginMm > 0) {
        const isEligibleForOutline = (path: PolylinePath) => {
            const layer = String(path.layer ?? "").trim();
            const n = layer ? Number(layer) : NaN;
            return Number.isFinite(n) && (n === 14 || n > 80);
        };

        const renderPaths = (p.variant.paths ?? []) as PolylinePath[];
        let eligible = renderPaths.filter(isEligibleForOutline);
        if (!eligible.length) {
            const packPaths = (((p.variant as any).packPaths ?? []) as PolylinePath[]) || [];
            eligible = packPaths.filter(isEligibleForOutline);
        }

        const outlineReference = pickLargestClosed(eligible);
        const seamCandidates = renderPaths.filter((pp) => {
            if (!pp.closed || (pp.points?.length ?? 0) < 3) return false;
            const layer = String(pp.layer ?? "").trim();
            return pp.kind === "seam" || layer === "1";
        });
        const seamToUse = pickLargestClosed(filterUsableOuterSeams(seamCandidates, outlineReference));

        if (seamToUse) {
            const bb = computeBounds([seamToUse]);
            if (bb) clipBounds = bb;
        } else if (outlineReference) {
            const offsetPaths = offsetClosedPolylines([outlineReference], outlineMarginMm);
            const bb = computeBounds(offsetPaths);
            if (bb) clipBounds = bb;
        }
    }

    const allPaths = (p.variant.paths ?? []) as PolylinePath[];
    const pointMarkers = allPaths.filter((pp) => pp.marker === "point");
    const nonMarkers = allPaths.filter((pp) => pp.marker !== "point");

    // Clip geometry to the rotated outline bounds so helpers don't visually collide while staying out of packing.
    // BUT: DXF POINT-derived markers are tiny and often slightly outside; draw those un-clipped so they stay visible.
    ctx.save();
    ctx.beginPath();
    ctx.rect(
        (clipBounds.minX - renderBounds.minX) * scale,
        (clipBounds.minY - renderBounds.minY) * scale,
        (clipBounds.maxX - clipBounds.minX) * scale,
        (clipBounds.maxY - clipBounds.minY) * scale
    );
    ctx.clip();

    ctx.strokeStyle = "#222";
    ctx.lineWidth = 1.5;
    const drawPaths = (paths: PolylinePath[]) => {
        for (const path of paths) {
            // Layers 2/3 and 87 remain internal metadata/validation geometry.
            // They can be inspected on canvas, but never become physical plot paths.
            // Layer 4 notch crosses remain physical and follow normal visibility.
            const showMetadataPoint =
                showGradingMetadataPoints &&
                path.marker === "point" &&
                isTurnCurveMetadataLayer(path.layer);
            if (!showMetadataPoint && !isPhysicalLayerVisible(path.layer, visibleLayers)) continue;
            if (!path.points.length) continue;
            ctx.beginPath();
            const b = renderBounds;
            const start = path.points[0];
            ctx.moveTo((start.x - b.minX) * scale, (start.y - b.minY) * scale);
            for (let i = 1; i < path.points.length; i++) {
                const pt = path.points[i];
                ctx.lineTo((pt.x - b.minX) * scale, (pt.y - b.minY) * scale);
            }
            if (path.closed) ctx.closePath();
            ctx.stroke();
        }
    };

    drawPaths(nonMarkers);
    ctx.restore();

    // Draw physical POINT markers (layer-4 notches) after clipping.
    if (pointMarkers.length) {
        ctx.strokeStyle = "#222";
        ctx.lineWidth = 1.5;
        drawPaths(pointMarkers);
    }

    // Label (conditional)
    if (showText) {
        // Rotate native annotation anchors around the same pivot as the piece
        // paths. These labels never contribute to bounds or packing geometry.
        const angle = p.variant.angle;
        const rad = degToRad(angle);
        const pivotX = (p.block.bounds.minX + p.block.bounds.maxX) / 2;
        const pivotY = (p.block.bounds.minY + p.block.bounds.maxY) / 2;
        for (const annotation of p.block.annotations ?? []) {
            if (!isPhysicalLayerVisible(annotation.layer, visibleLayers)) continue;
            const dx = annotation.position.x - pivotX;
            const dy = annotation.position.y - pivotY;
            const x = pivotX + dx * Math.cos(rad) - dy * Math.sin(rad);
            const y = pivotY + dx * Math.sin(rad) + dy * Math.cos(rad);
            ctx.save();
            ctx.translate((x - renderBounds.minX) * scale, (y - renderBounds.minY) * scale);
            ctx.rotate(degToRad(annotation.rotation + angle));
            ctx.fillStyle = "#444";
            ctx.font = `${annotation.height * scale}px sans-serif`;
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            ctx.fillText(annotation.text, 0, 0);
            ctx.restore();
        }
        const b = renderBounds;
        const centerX = (b.minX + b.maxX) / 2;
        const centerY = (b.minY + b.maxY) / 2;
        const cx = (centerX - b.minX) * scale;
        const cy = (centerY - b.minY) * scale;
        const label = p.block.pieceLabel || p.block.name;

        const pieceWidthMm = Math.max(1, b.maxX - b.minX);
        const fitLabel = (text: string, baseHeightMm: number) => {
            const charWidthMm = baseHeightMm * 0.6;
            const rawWidthMm = Math.max(charWidthMm, text.length * charWidthMm);
            const maxWidthMm = pieceWidthMm * 0.8;
            const scaleMm = rawWidthMm > maxWidthMm ? maxWidthMm / rawWidthMm : 1;
            const heightMm = Math.max(3, baseHeightMm * scaleMm);
            return { heightPx: heightMm * scale, charWidthPx: charWidthMm * scale, textWidthPx: rawWidthMm * scale * scaleMm };
        };

        const nameSizing = fitLabel(label, labelHeightMm);
        const sizeSizing = fitLabel(p.block.sizeLabel ? String(p.block.sizeLabel).toUpperCase() : "", labelHeightMm * 0.8);
        const lineGapPx = Math.max(2, (labelHeightMm * 0.2) * scale);

        ctx.fillStyle = "#333";
        ctx.font = `${nameSizing.heightPx.toFixed(1)}px ui-sans-serif, system-ui, Arial`;
        const textW = ctx.measureText(label).width || nameSizing.textWidthPx;
        ctx.fillText(label, cx - textW / 2, cy);

        if (p.block.sizeLabel) {
            const size = String(p.block.sizeLabel).toUpperCase();
            ctx.fillStyle = "#666";
            ctx.font = `${sizeSizing.heightPx.toFixed(1)}px ui-sans-serif, system-ui, Arial`;
            const w = ctx.measureText(size).width || sizeSizing.textWidthPx;
            ctx.fillText(size, cx - w / 2, cy + nameSizing.heightPx + lineGapPx);
        }
    }

    if (showBoundingBoxes) {
        const rb = renderBounds;
        const ob = p.variant.bounds; // rotated outline bounds (packing)
        const obWidth = ob.maxX - ob.minX;
        const obHeight = ob.maxY - ob.minY;
        const offsetX = (ob.minX - rb.minX) * scale;
        const offsetY = (ob.minY - rb.minY) * scale;
        ctx.save();
        ctx.strokeStyle = "#ff3b30";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(offsetX, offsetY, obWidth * scale, obHeight * scale);
        ctx.restore();
    }

    ctx.restore();
}

// --- Browser DXF parsing ---


export function collectPolylineTypeHintsFromText(text: string): PolylineTypeHints {
    const lines = text.split(/\r?\n/);
    const result: PolylineTypeHints = { blocks: new Map(), entities: [] };

    let section: string | null = null;
    let currentBlock: string | null = null;

    const pushHint = (key: string | null, value: number | undefined) => {
        if (!key) return;
        const arr = result.blocks.get(key) ?? [];
        arr.push(value);
        if (!result.blocks.has(key)) result.blocks.set(key, arr);
    };

    for (let i = 0; i < lines.length - 1; i += 2) {
        const code = lines[i]?.trim();
        const value = lines[i + 1]?.trim() ?? "";

        if (code === "0" && value === "SECTION") {
            const nameCode = lines[i + 2]?.trim();
            const nameVal = lines[i + 3]?.trim();
            if (nameCode === "2" && nameVal) {
                section = nameVal;
                currentBlock = null;
                i += 2; // skip the section name pair we just consumed
            }
            continue;
        }

        if (code === "0" && value === "ENDSEC") {
            section = null;
            currentBlock = null;
            continue;
        }

        if (section !== "BLOCKS" && section !== "ENTITIES") continue;

        if (section === "BLOCKS") {
            if (code === "0" && value === "BLOCK") {
                currentBlock = null;
                continue;
            }
            if (code === "0" && value === "ENDBLK") {
                currentBlock = null;
                continue;
            }
            if (currentBlock === null && code === "2") {
                currentBlock = value;
                if (!result.blocks.has(value)) result.blocks.set(value, []);
                continue;
            }
        }

        const isEntitiesSection = section === "ENTITIES";
        const target = section === "BLOCKS" && currentBlock ? "BLOCK" : isEntitiesSection ? "ENTITIES" : null;

        if (code === "0" && value === "POLYLINE") {
            let hint: number | undefined;
            let j = i + 2;
            while (j < lines.length - 1) {
                const c = lines[j]?.trim();
                const v = lines[j + 1]?.trim() ?? "";
                if (c === "0") break; // next entity starts
                if (c === "250") {
                    const num = Number(v);
                    if (Number.isFinite(num)) hint = num;
                }
                j += 2;
            }

            if (target === "BLOCK" && currentBlock) {
                pushHint(currentBlock, hint);
            } else if (target === "ENTITIES") {
                result.entities.push(hint);
            }

            i = j - 2; // continue parsing from the last inspected pair
        }
    }

    return result;
}

export async function parseDxfTextInBrowser(text: string): Promise<DxfFile | null> {
    try {
        // Try dynamic import of dxf-parser (works in browser bundles)
        const mod = (await import(/* webpackIgnore: true */ "dxf-parser")) as DxfParserModule;
        const ParserCtor = mod?.DxfParser || mod?.default;
        if (!ParserCtor) throw new Error("DXF parser library not available.");
        const parser = new ParserCtor();
        const parsed = parser.parseSync ? parser.parseSync(text) : parser.parse(text);
        const polylineHints = collectPolylineTypeHintsFromText(text);
        // The library returns an object with entities/blocks; we expect { blocks: Record<string, DxfBlock> }
        // Ensure shape compatibility
        const blocks: Record<string, DxfBlock> = {};
        const srcBlocks = (parsed?.blocks ?? {}) as Record<string, any>;
        for (const [name, blk] of Object.entries(srcBlocks)) {
            const blockPolyHints = polylineHints.blocks.get(name) ?? [];
            let polyIdx = 0;
            const entities = Array.isArray(blk?.entities)
                ? blk.entities.map((raw: any) => {
                    const mapped = mapParserEntityToDxfEntity(raw);
                    if (mapped.type === "POLYLINE") {
                        const hint = blockPolyHints[polyIdx++];
                        if (Number.isFinite(hint)) mapped.polyType = Number(hint);
                    }
                    return mapped;
                })
                : [];
            blocks[name] = { name, entities };
        }
        // Map top-level ENTITIES too (needed for saved INSERT positions)
        let entityPolyIdx = 0;

        const entities = Array.isArray(parsed?.entities)
            ? parsed.entities.map((raw: any) => {
                const mapped = mapParserEntityToDxfEntity(raw);
                if (mapped.type === "POLYLINE") {
                    const hint = polylineHints.entities[entityPolyIdx++];
                    if (Number.isFinite(hint)) mapped.polyType = Number(hint);
                }
                return mapped;
            })
            : [];
        // Fallback: if no blocks section, wrap ENTITIES into a synthetic block
        if (!Object.keys(blocks).length && entities.length) {
            blocks["EXPORT"] = { name: "EXPORT", entities };
        }
        return { blocks, entities };
    } catch (e) {
        console.error("DXF parse error", e);
        return null;
    }
}
