import type { PolyPackedItem } from "../components/dxf-editor-v2/editor/types.ts";

/** Elitist permutation search; geometry and allowed rotations stay unchanged. */
export function createExtremeOrderSearch(
  items: PolyPackedItem[],
  equivalenceKey: (item: PolyPackedItem) => string,
  random: () => number = Math.random
) {
  const keys = new Map(items.map(item => [item, equivalenceKey(item)]));
  const signature = (order: PolyPackedItem[]) => JSON.stringify(order.map(item => keys.get(item)));
  const longest = (item: PolyPackedItem) => Math.max(...item.variants.map(v => Math.max(v.variant.width, v.variant.height)));
  const shortest = (item: PolyPackedItem) => Math.min(...item.variants.map(v => Math.min(v.variant.width, v.variant.height)));
  const seeds = [
    items.slice().sort((a, b) => b.area - a.area),
    items.slice().sort((a, b) => longest(b) - longest(a)),
    items.slice().sort((a, b) => shortest(b) - shortest(a)),
    items.slice().sort((a, b) => longest(b) / Math.max(1, shortest(b)) - longest(a) / Math.max(1, shortest(a))),
    items.slice().sort((a, b) => a.area - b.area),
  ];
  const seen = new Set<string>();
  const elite: Array<{ order: PolyPackedItem[]; height: number }> = [];
  let proposals = 0;
  const index = (length: number) => Math.min(length - 1, Math.floor(random() * length));
  return {
    next(): PolyPackedItem[] | null {
      for (let retry = 0; retry < 64; retry++) {
        let order = seeds.shift();
        if (!order) {
          const restart = proposals++ % 7 === 0 || !elite.length;
          order = (restart ? items : elite[index(elite.length)].order).slice();
          if (restart) {
            for (let i = order.length - 1; i > 0; i--) {
              const j = index(i + 1);
              [order[i], order[j]] = [order[j], order[i]];
            }
          } else {
            // Insertion, swap and segment reversal explore different neighbours.
            const a = index(order.length), b = index(order.length);
            const operation = index(3);
            if (operation === 0) [order[a], order[b]] = [order[b], order[a]];
            else if (operation === 1) order.splice(b, 0, ...order.splice(a, 1));
            else {
              const from = Math.min(a, b), to = Math.max(a, b);
              order.splice(from, to - from + 1, ...order.slice(from, to + 1).reverse());
            }
          }
        }
        const key = signature(order);
        if (seen.has(key)) continue;
        seen.add(key);
        return order;
      }
      return null;
    },
    record(order: PolyPackedItem[], height: number) {
      if (!Number.isFinite(height)) return;
      seen.add(signature(order));
      elite.push({ order: order.slice(), height });
      elite.sort((a, b) => a.height - b.height);
      elite.length = Math.min(8, elite.length);
    },
  };
}
