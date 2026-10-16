import { RUST_PACKER_WASM_BASE64 } from "../../generated/rust-packer-wasm.ts";
import type { PolyRasterBackend } from "../components/dxf-editor-v3/editor/types.ts";
import {
  decodeRasterPackingOutput,
  encodeRasterPackingInput,
} from "./raster-packing-codec.ts";

type RustWasmExports = {
  memory: WebAssembly.Memory;
  dxf_alloc: (length: number) => number;
  dxf_dealloc: (pointer: number, length: number) => void;
  dxf_pack: (pointer: number, length: number) => number;
  dxf_result_len: () => number;
};

let exportsPromise: Promise<RustWasmExports> | null = null;

const loadExports = async () => {
  if (!RUST_PACKER_WASM_BASE64) {
    throw new Error("Rust WebAssembly packing module was not built");
  }
  if (!exportsPromise) {
    exportsPromise = (async () => {
      const binary = Uint8Array.from(
        atob(RUST_PACKER_WASM_BASE64),
        (character) => character.charCodeAt(0),
      );
      const instantiated = await WebAssembly.instantiate(binary, {});
      return instantiated.instance.exports as unknown as RustWasmExports;
    })();
  }
  return exportsPromise;
};

export const rustWasmRasterBackend: PolyRasterBackend = async (input) => {
  const rust = await loadExports();
  const payload = encodeRasterPackingInput(input);
  const startedAt = performance.now();
  const inputPointer = rust.dxf_alloc(payload.byteLength);
  if (!inputPointer) throw new Error("Rust WebAssembly input allocation failed");
  new Uint8Array(rust.memory.buffer, inputPointer, payload.byteLength).set(payload);

  let outputPointer = 0;
  let outputLength = 0;
  try {
    outputPointer = rust.dxf_pack(inputPointer, payload.byteLength);
    outputLength = rust.dxf_result_len();
    if (!outputPointer || !outputLength) {
      throw new Error("Rust WebAssembly packer could not place the order");
    }
    const output = new Uint8Array(
      rust.memory.buffer,
      outputPointer,
      outputLength,
    ).slice();
    return decodeRasterPackingOutput(
      output,
      "rust-wasm",
      performance.now() - startedAt,
    );
  } finally {
    rust.dxf_dealloc(inputPointer, payload.byteLength);
    if (outputPointer && outputLength) {
      rust.dxf_dealloc(outputPointer, outputLength);
    }
  }
};
