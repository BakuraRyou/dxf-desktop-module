import type {
  PolyPackedItem,
  PolyRasterBackendInput,
  PolyRasterBackendResult,
  PolyVariant,
} from "../components/dxf-editor-v3/editor/types.ts";

const INPUT_MAGIC = 0x50465844;
const OUTPUT_MAGIC = 0x52465844;
const PROTOCOL_VERSION = 1;

const bitRowsForVariant = (variant: PolyVariant) => {
  if (variant.bitRows?.length === variant.maskH) return variant.bitRows;
  const words = Math.max(1, Math.ceil(variant.maskW / 32));
  return variant.mask.map((row) => {
    const bits = new Uint32Array(words);
    for (let x = 0; x < Math.min(variant.maskW, row.length); x += 1) {
      if (row[x]) bits[x >>> 5] |= (1 << (x & 31)) >>> 0;
    }
    return bits;
  });
};

export const sortedPolyVariants = (item: PolyPackedItem) =>
  item.variants
    .slice()
    .sort(
      (left, right) =>
        left.maskH - right.maskH || right.maskW - left.maskW,
    );

export function encodeRasterPackingInput(input: PolyRasterBackendInput) {
  const prepared = input.order.map((item) =>
    sortedPolyVariants(item).map((variant) => ({
      variant,
      rows: bitRowsForVariant(variant),
    })),
  );
  let byteLength = 4 + 4 + 4 + 8 + 8 + 4;
  for (const variants of prepared) {
    byteLength += 4;
    for (const { variant, rows } of variants) {
      const rowWords = Math.max(1, Math.ceil(variant.maskW / 32));
      byteLength += 4 + 4 + 4 + 8 + variant.maskH * rowWords * 4;
      if (rows.some((row) => row.length !== rowWords)) {
        throw new Error("Invalid raster variant bit-row width");
      }
    }
  }

  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  let offset = 0;
  const u32 = (value: number) => {
    view.setUint32(offset, value >>> 0, true);
    offset += 4;
  };
  const f64 = (value: number) => {
    view.setFloat64(offset, value, true);
    offset += 8;
  };

  u32(INPUT_MAGIC);
  u32(PROTOCOL_VERSION);
  u32(input.fabricCells);
  f64(input.fabricWidth);
  f64(input.cell);
  u32(prepared.length);
  for (const variants of prepared) {
    u32(variants.length);
    for (const { variant, rows } of variants) {
      const rowWords = Math.max(1, Math.ceil(variant.maskW / 32));
      u32(variant.maskW);
      u32(variant.maskH);
      u32(rowWords);
      f64(variant.variant.width);
      for (const row of rows) {
        for (let word = 0; word < rowWords; word += 1) u32(row[word]);
      }
    }
  }
  return new Uint8Array(buffer);
}

export function decodeRasterPackingOutput(
  bytes: Uint8Array,
  backend: PolyRasterBackendResult["backend"],
  durationMs: number,
): PolyRasterBackendResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const u32 = () => {
    if (offset + 4 > view.byteLength) {
      throw new Error("Truncated Rust packing result");
    }
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };
  if (u32() !== OUTPUT_MAGIC || u32() !== PROTOCOL_VERSION) {
    throw new Error("Invalid Rust packing result");
  }
  const count = u32();
  const choices = Array.from({ length: count }, () => ({
    variantIndex: u32(),
    x: u32(),
    y: u32(),
    top: u32(),
  }));
  if (offset !== view.byteLength) {
    throw new Error("Unexpected trailing Rust packing result");
  }
  return { backend, durationMs, choices };
}
