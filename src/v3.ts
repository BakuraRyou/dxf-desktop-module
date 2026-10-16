import { installPackingRuntime } from '../vendor/dxf-editor-v3/src/frontend/lib/packing-runtime';
import { progressivePackDrawableBlocksPoly } from '../vendor/dxf-editor-v3/src/frontend/components/dxf-editor-v3/editor/util';
import { rustWasmRasterBackend } from '../vendor/dxf-editor-v3/src/frontend/lib/rust-raster-wasm';
import { rustNativeRasterBackend, cancelRustRasterPacking } from '../vendor/dxf-editor-v3/src/electron/rust-raster-backend';
import { startModule } from './runtime';
startModule({ installPackingRuntime, progressivePackDrawableBlocksPoly, rustWasmRasterBackend, rustNativeRasterBackend, cancelRustRasterPacking }, import.meta.url);
