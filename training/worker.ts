import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  parseDxfTextInBrowser, buildDrawableBlocks, deriveBlockNameMap, detectHelperBaseSizeFromMarkers,
  prepareBlocksForWorker, computeBlockOutlineArea, buildPolyVariants, compactPlacementsVectorProgressive,
  validateRealBoundingPlacements, packPolyOrderProgressive,
} from '../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util';
import { detectContourWarnings } from '../vendor/dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/contour-diagnostics';
import { rustWasmRasterBackend } from '../vendor/dxf-editor-v2/src/frontend/lib/rust-raster-wasm';
const policy = createRequire(import.meta.url)('../src/order-policy.cjs');

// Parser diagnostics belong on stderr, never in the IPC result.
console.log = (...args) => console.error(...args);
process.once('message', async (request: any) => {
  try {
    const { config } = request;
    if (request.action === 'prepare') {
      const text = fs.readFileSync(request.file, 'utf8');
      const units = text.match(/\$INSUNITS\s*\r?\n\s*70\s*\r?\n\s*(\d+)/)?.[1];
      if (units && !['0', '4'].includes(units)) throw new Error(`DXF-Einheit ${units}: zuerst in Millimeter umwandeln`);
      const dxf = await parseDxfTextInBrowser(text);
      if (!dxf?.blocks) throw new Error('DXF konnte nicht gelesen werden');
      const nameMap = deriveBlockNameMap(dxf.blocks);
      const base = detectHelperBaseSizeFromMarkers(dxf.blocks, nameMap);
      const options = { nameMap, helperBaseSizeLabel: base, forceHelperBasePropagation: true };
      const original = buildDrawableBlocks(dxf.blocks, null, options);
      if (base && detectContourWarnings(dxf, base, original).length) throw new Error('Außenlinien müssen vor dem Training korrigiert werden');
      const selected = config.sizes.length ? buildDrawableBlocks(dxf.blocks, new Set(config.sizes), options) : original;
      if (selected.length < 2 || selected.length > 2000) throw new Error('Ein Auftrag muss 2 bis 2000 Teile enthalten');
      // Explicit training contract: 0/180 only. No mirroring and no name-derived rotation hints.
      const blocks = prepareBlocksForWorker(selected.map(b => ({ ...b, rotationStepOverride: 180, manualAngleOverride: undefined })), true, config.gap / 2).blocks;
      if (blocks.some(b => !(b.width > 0 && b.height > 0) || b.width > config.width)) throw new Error('Schnittteile passen nicht in die Stoffbreite');
      const inputs = policy.features(blocks.map(b => ({ width: b.width, height: b.height, area: computeBlockOutlineArea(b) })), config.width);
      fs.writeFileSync(request.destination, JSON.stringify({ blocks, inputs }));
      process.send?.({ ok: true, pieces: blocks.length, units: units === '4' ? 'mm' : 'assumed-mm' });
    } else {
      const { blocks, inputs } = JSON.parse(fs.readFileSync(request.prepared, 'utf8'));
      const model = policy.validate(request.model);
      const items = blocks.map((block: any) => ({ block, area: computeBlockOutlineArea(block),
        variants: buildPolyVariants(block, 180, config.grid, 0).filter(v => v.variant.width <= config.width + 1e-6 && v.maskW <= Math.ceil(config.width / config.grid)) }));
      if (items.some((i: any) => !i.variants.length)) throw new Error('Keine zulässige Rotation');
      const cache = new Map<string, number>();
      async function evaluate(order: number[]) {
        const key = order.join(',');
        if (cache.has(key)) return cache.get(key)!;
        const sorted = order.map(i => items[i]);
        const packed = (await packPolyOrderProgressive(sorted, Math.ceil(config.width / config.grid), config.grid, 0, {
          attempt: 1, totalAttempts: 1, totalPieces: blocks.length, fabricWidth: config.width,
          rasterBackend: rustWasmRasterBackend,
        })).result;
        if (!packed) throw new Error('Keine vollständige Packung');
        const result = await compactPlacementsVectorProgressive(packed.placements, config.width, { passes: 1, maxDurationMs: config.compactionMs });
        if (!result || result.placements.length !== blocks.length || !validateRealBoundingPlacements(result.placements, config.width)
          || result.placements.some(p => p.variant.angle !== 0 && p.variant.angle !== 180)) throw new Error('Packung verletzt die Trainingsregeln');
        cache.set(key, result.usedHeight);
        return result.usedHeight;
      }
      const rng = policy.random(request.seed);
      if (request.action === 'train') {
        const samples = [];
        for (let i = 0; i < config.samples; i++) {
          const sample = policy.order(model, inputs, rng, true);
          samples.push({ height: await evaluate(sample.order), gradient: sample.gradient });
        }
        policy.update(model, samples, config.learningRate);
        process.send?.({ ok: true, model, bestHeight: Math.min(...samples.map(s => s.height)), meanHeight: samples.reduce((s, v) => s + v.height, 0) / samples.length });
      } else if (request.action === 'validate') {
        // Equal proposal counts, raster precision and refinement budget on both sides.
        const heuristics = [
          (a: any, b: any) => b.area - a.area,
          (a: any, b: any) => b.block.height - a.block.height,
          (a: any, b: any) => b.block.width - a.block.width,
          (a: any, b: any) => b.block.height / b.block.width - a.block.height / a.block.width,
          (a: any, b: any) => a.area - b.area,
        ];
        const indices = items.map((_: any, i: number) => i);
        const baseline = [];
        for (const compare of heuristics) baseline.push(await evaluate(indices.slice().sort((a: number, b: number) => compare(items[a], items[b]))));
        const learned = [];
        for (const order of policy.candidates(model, inputs, 5, request.seed)) learned.push(await evaluate(order));
        process.send?.({ ok: true, baselineHeight: Math.min(...baseline), learnedHeight: Math.min(...learned) });
      } else throw new Error('Unbekannter Trainingsschritt');
    }
  } catch (error: any) { process.send?.({ ok: false, error: error.message }); }
  finally { process.disconnect?.(); }
});
