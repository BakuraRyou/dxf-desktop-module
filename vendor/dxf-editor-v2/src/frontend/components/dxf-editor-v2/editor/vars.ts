// --- UI constants ---
export const PAGE_MARGIN = 12; // px
export const PACK_PADDING = 0; // mm
// Packing gap between pieces. Keep this at 0 if you want pieces to touch.
// (Do not reuse OUTLINE_MARGIN_MM here; that margin is used to generate/display the seam/cutline.)
export const PACK_GAP_MM = 0; // mm
export const OUTLINE_MARGIN_MM = 10; // mm
export const PACK_MAX_ITERATIONS = 400;
export const PACK_HEIGHT_GROWTH = 1.25;
export const POSITION_EPS = 1e-4;
export const OVERLAP_PIECE_MARGIN_MM = 0; // spacing between different pieces when overlapping sizes