/** Bounds for retained original rows and staged edits, including larger values. */
export const GRID_CELL_LIMIT = 262_144
export const GRID_PAGE_BYTES = 8 * 1024 * 1024
export const GRID_PREVIEW_CELL_LIMIT = 16_384
// Do not expand the previous maximum aggregate server-side projection when a
// page has many rows or columns; large cells need a correspondingly smaller page.
export const GRID_FETCH_CHAR_BUDGET = 201 * 100 * (GRID_PREVIEW_CELL_LIMIT + 16)
