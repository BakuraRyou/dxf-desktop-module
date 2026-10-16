import { installPackingRuntime } from '../../dxf-editor-v3/src/frontend/lib/packing-runtime';
import { progressivePackDrawableBlocksPoly } from '../../dxf-editor-v3/src/frontend/components/dxf-editor-v3/editor/util';
import { rustWasmRasterBackend } from '../../dxf-editor-v3/src/frontend/lib/rust-raster-wasm';
import { rustNativeRasterBackend, cancelRustRasterPacking } from '../../dxf-editor-v3/src/electron/rust-raster-backend';
import { startModule } from './runtime';
startModule({ installPackingRuntime, progressivePackDrawableBlocksPoly, rustWasmRasterBackend, rustNativeRasterBackend, cancelRustRasterPacking }, import.meta.url);
