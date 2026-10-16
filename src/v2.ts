import { installPackingRuntime } from '../../dxf-editor-v2/src/frontend/lib/packing-runtime';
import { progressivePackDrawableBlocksPoly, computeBlockOutlineArea } from '../../dxf-editor-v2/src/frontend/components/dxf-editor-v2/editor/util';
import { rustWasmRasterBackend } from '../../dxf-editor-v2/src/frontend/lib/rust-raster-wasm';
import { rustNativeRasterBackend, cancelRustRasterPacking } from '../../dxf-editor-v2/src/electron/rust-raster-backend';
import { startModule } from './runtime';
startModule({ installPackingRuntime, progressivePackDrawableBlocksPoly, computeBlockOutlineArea, rustWasmRasterBackend, rustNativeRasterBackend, cancelRustRasterPacking }, import.meta.url);
