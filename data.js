/**
 * PTO Copy/Paste Prototype — Data Model
 * --------------------------------------
 * Mirrors the Plan Takeoff (PTO) structure:
 *   - SHEETS:    drawing pages (Sheet_1.1, Sheet_1.2, ...). The active sheet
 *                determines which takeoff items are visible/editable.
 *   - SECTIONS:  takeoff folders shared across sheets (SILL PLATE, DOORS, ...).
 *   - ITEMS:     takeoff measurements. Each item belongs to ONE sheet and ONE
 *                section. Copying/pasting an item creates a new item on the
 *                currently-active sheet, inside the same section.
 *
 * Item.type drives the tool icon:
 *   'linear' → ruler   |   'count' → crosshair   |   'area' → grid
 */

const SHEETS = [
  { id: "sheet-1-1", name: "Sheet_1.1", label: "Foundation Plan" },
  { id: "sheet-1-2", name: "Sheet_1.2", label: "First Floor Plan" },
  { id: "sheet-1-3", name: "Sheet_1.3", label: "Rear Elevation" },
  { id: "sheet-1-4", name: "Sheet_1.4", label: "Left Elevation" },
  { id: "sheet-1-5", name: "Sheet_1.5", label: "Right Elevation" },
  { id: "sheet-1-6", name: "Sheet_1.6", label: "Roof Plan" },
  { id: "sheet-1-7", name: "Sheet_1.7", label: "Wall Sections" }
];

// Section folders (shared across all sheets)
const SECTIONS = [
  { id: "sec-doors-ext", name: "DOORS EXTERIOR", expanded: false },
  { id: "sec-doors-int", name: "DOORS INTERIOR", expanded: false },
  { id: "sec-sill", name: "SILL PLATE", expanded: true },
  { id: "sec-drywall", name: "DRYWALL", expanded: false },
  { id: "sec-insulation", name: "INSULATION", expanded: false },
  { id: "sec-rim", name: "RIM BOARD", expanded: false },
  { id: "sec-roofing", name: "ROOFING", expanded: false },
  { id: "sec-sheathing", name: "SHEATHING", expanded: false },
  { id: "sec-siding", name: "SIDING", expanded: false },
  { id: "sec-walls-ext", name: "WALLS EXTERIOR", expanded: false },
  { id: "sec-walls-int", name: "WALLS INTERIOR", expanded: false },
  { id: "sec-windows", name: "WINDOWS", expanded: false }
];

/**
 * Color coding from the PTO design system.
 * type: 'linear' | 'count' | 'area'
 * measurement: a human-readable measurement string (length / area / count)
 */
const ITEMS = [
  // ---- SILL PLATE (visible on Sheet_1.1 Foundation) ----
  { id: "itm-1", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x4", type: "linear", quantity: 124, unit: "LF", color: "#A0522D", measurement: "124.0 LF" },
  { id: "itm-2", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x4_DOUBLE", type: "linear", quantity: 86, unit: "LF", color: "#FD7E14", measurement: "86.0 LF" },
  { id: "itm-3", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6", type: "linear", quantity: 210, unit: "LF", color: "#808000", measurement: "210.0 LF" },
  { id: "itm-4", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6_DOUBLE", type: "linear", quantity: 64, unit: "LF", color: "#F5C6CB", measurement: "64.0 LF" },

  // ---- RIM BOARD (Sheet_1.1) ----
  { id: "itm-5", sheetId: "sheet-1-1", sectionId: "sec-rim", name: "Rim Board 1-1/8x11-7/8", type: "linear", quantity: 168, unit: "LF", color: "#1a47ba", measurement: "168.0 LF" },
  { id: "itm-6", sheetId: "sheet-1-1", sectionId: "sec-rim", name: "Rim Board 1-1/8x9-1/2", type: "linear", quantity: 92, unit: "LF", color: "#6c5ce7", measurement: "92.0 LF" },

  // ---- DOORS EXTERIOR (Sheet_1.2 First Floor) ----
  { id: "itm-7", sheetId: "sheet-1-2", sectionId: "sec-doors-ext", name: "Front Entry Door 36\"", type: "count", quantity: 1, unit: "EA", color: "#1a47ba", measurement: "1 EA" },
  { id: "itm-8", sheetId: "sheet-1-2", sectionId: "sec-doors-ext", name: "Sliding Patio Door 72\"", type: "count", quantity: 1, unit: "EA", color: "#6c5ce7", measurement: "1 EA" },
  { id: "itm-9", sheetId: "sheet-1-2", sectionId: "sec-doors-ext", name: "Garage Entry Door 32\"", type: "count", quantity: 1, unit: "EA", color: "#e84393", measurement: "1 EA" },

  // ---- DOORS INTERIOR (Sheet_1.2) ----
  { id: "itm-10", sheetId: "sheet-1-2", sectionId: "sec-doors-int", name: "Interior Door 30\"", type: "count", quantity: 6, unit: "EA", color: "#e84393", measurement: "6 EA" },
  { id: "itm-11", sheetId: "sheet-1-2", sectionId: "sec-doors-int", name: "Interior Door 32\"", type: "count", quantity: 4, unit: "EA", color: "#FD7E14", measurement: "4 EA" },
  { id: "itm-12", sheetId: "sheet-1-2", sectionId: "sec-doors-int", name: "Pocket Door 30\"", type: "count", quantity: 2, unit: "EA", color: "#808000", measurement: "2 EA" },

  // ---- WALLS EXTERIOR (Sheet_1.2) ----
  { id: "itm-13", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 9'", type: "linear", quantity: 188, unit: "LF", color: "#1a47ba", measurement: "188.0 LF" },
  { id: "itm-14", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 8'", type: "linear", quantity: 142, unit: "LF", color: "#21ba45", measurement: "142.0 LF" },

  // ---- WALLS INTERIOR (Sheet_1.2) ----
  { id: "itm-15", sheetId: "sheet-1-2", sectionId: "sec-walls-int", name: "Int Wall 2x4 8'", type: "linear", quantity: 240, unit: "LF", color: "#e84393", measurement: "240.0 LF" },
  { id: "itm-16", sheetId: "sheet-1-2", sectionId: "sec-walls-int", name: "Int Wall 2x4 9'", type: "linear", quantity: 96, unit: "LF", color: "#F5C6CB", measurement: "96.0 LF" },

  // ---- WINDOWS (Sheet_1.3 Rear Elevation) ----
  { id: "itm-17", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "DH Window 30x48", type: "count", quantity: 5, unit: "EA", color: "#1a47ba", measurement: "5 EA" },
  { id: "itm-18", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "DH Window 36x60", type: "count", quantity: 3, unit: "EA", color: "#6c5ce7", measurement: "3 EA" },
  { id: "itm-19", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "Casement 24x48", type: "count", quantity: 2, unit: "EA", color: "#e84393", measurement: "2 EA" },

  // ---- SIDING (Sheet_1.3) ----
  { id: "itm-20", sheetId: "sheet-1-3", sectionId: "sec-siding", name: "Vinyl Siding D4", type: "area", quantity: 1450, unit: "SF", color: "#21ba45", measurement: "1,450 SF" },
  { id: "itm-21", sheetId: "sheet-1-3", sectionId: "sec-siding", name: "Fiber Cement Lap 8\"", type: "area", quantity: 380, unit: "SF", color: "#FD7E14", measurement: "380 SF" },

  // ---- ROOFING (Sheet_1.6 Roof Plan) ----
  { id: "itm-22", sheetId: "sheet-1-6", sectionId: "sec-roofing", name: "Architectural Shingles", type: "area", quantity: 32, unit: "SQ", color: "#d63031", measurement: "32 SQ" },
  { id: "itm-23", sheetId: "sheet-1-6", sectionId: "sec-roofing", name: "Ridge Cap Shingles", type: "linear", quantity: 64, unit: "LF", color: "#e84393", measurement: "64.0 LF" },
  { id: "itm-24", sheetId: "sheet-1-6", sectionId: "sec-roofing", name: "Drip Edge", type: "linear", quantity: 188, unit: "LF", color: "#1a47ba", measurement: "188.0 LF" },

  // ---- SHEATHING (Sheet_1.6) ----
  { id: "itm-25", sheetId: "sheet-1-6", sectionId: "sec-sheathing", name: "1/2\" Plywood Roof Sheathing", type: "area", quantity: 2240, unit: "SF", color: "#6c5ce7", measurement: "2,240 SF" }
];

// Tool-type → Font Awesome icon
const TYPE_ICONS = {
  linear: "fa-solid fa-ruler",
  count: "fa-solid fa-crosshairs",
  area: "fa-solid fa-table-cells"
};

const TYPE_LABELS = {
  linear: "Linear",
  count: "Count",
  area: "Area"
};

// Unit options per tool type (used by the edit modal)
const UNIT_OPTIONS = {
  linear: ["LF", "FT"],
  count: ["EA"],
  area: ["SF", "SQ", "SY"]
};

const COLOR_SWATCHES = [
  "#A0522D", "#FD7E14", "#808000", "#F5C6CB", "#F9E79F",
  "#1a47ba", "#6c5ce7", "#e84393", "#21ba45", "#d63031"
];
