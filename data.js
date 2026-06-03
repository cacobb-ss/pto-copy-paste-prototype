/* ====================================================================
   PTO Copy/Paste Prototype — DATA MODEL (visual canvas edition)
   --------------------------------------------------------------------
   Everything is drawn on an SVG canvas with a fixed user-coordinate
   space of VIEW_W x VIEW_H. Measurements carry real geometry:

     • line  → { x1, y1, x2, y2 }                 (Linear, LF)
     • area  → { points: [{x,y}, ...] }           (Area,  SF)
     • point → { x, y, count }                    (Count, EA)

   PX_PER_FOOT converts screen geometry to a quantity for the labels.
   ==================================================================== */

const VIEW_W = 1200;
const VIEW_H = 800;
const PX_PER_FOOT = 6;            // 6 user-units == 1 foot

// ---- Sheets (each owns a blueprint background + its measurements) ----
const SHEETS = [
  { id: "sheet-1-1", name: "Sheet_1.1", label: "Foundation Plan", plan: "foundation" },
  { id: "sheet-1-2", name: "Sheet_1.2", label: "First Floor Plan", plan: "floor" },
  { id: "sheet-1-3", name: "Sheet_1.3", label: "Rear Elevation",  plan: "elevation" }
];

// ---- Takeoff sections (right panel, shared across sheets) ----
const SECTIONS = [
  { id: "sec-sill",      name: "SILL PLATE",      expanded: true },
  { id: "sec-walls-ext", name: "WALLS EXTERIOR",  expanded: true },
  { id: "sec-walls-int", name: "WALLS INTERIOR",  expanded: true },
  { id: "sec-doors",     name: "DOORS",           expanded: true },
  { id: "sec-windows",   name: "WINDOWS",         expanded: true },
  { id: "sec-rooms",     name: "ROOMS / SLAB",    expanded: true },
  { id: "sec-roofing",   name: "ROOFING",         expanded: true },
  { id: "sec-siding",    name: "SIDING",          expanded: true }
];

// ---- PTO color palette (from design system) ----
const COLOR_SWATCHES = [
  "#A0522D", "#FD7E14", "#808000", "#F5C6CB", "#F9E79F",
  "#1a47ba", "#6c5ce7", "#e84393", "#21ba45", "#d63031", "#23394F"
];

// type → metadata
const MTYPE_META = {
  line:  { icon: "fa-solid fa-ruler",          label: "Linear", unit: "LF" },
  area:  { icon: "fa-solid fa-draw-polygon",   label: "Area",   unit: "SF" },
  point: { icon: "fa-solid fa-location-crosshairs", label: "Count", unit: "EA" }
};

/* --------------------------------------------------------------------
   MEASUREMENTS
   Each has: id, sheetId, sectionId, name, mtype, color, geom
   geom shape depends on mtype (see header).
   -------------------------------------------------------------------- */
const MEASUREMENTS = [
  /* ===== Sheet 1.1 — Foundation Plan ===== */
  // Sill plate perimeter (lines)
  { id: "m-101", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6 (North)", mtype: "line", color: "#A0522D", geom: { x1: 240, y1: 180, x2: 840, y2: 180 } },
  { id: "m-102", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6 (East)",  mtype: "line", color: "#A0522D", geom: { x1: 840, y1: 180, x2: 840, y2: 560 } },
  { id: "m-103", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6 (South)", mtype: "line", color: "#A0522D", geom: { x1: 840, y1: 560, x2: 240, y2: 560 } },
  { id: "m-104", sheetId: "sheet-1-1", sectionId: "sec-sill", name: "SILL_2x6 (West)",  mtype: "line", color: "#A0522D", geom: { x1: 240, y1: 560, x2: 240, y2: 180 } },
  // Slab area
  { id: "m-105", sheetId: "sheet-1-1", sectionId: "sec-rooms", name: "Garage Slab", mtype: "area", color: "#F9E79F", geom: { points: [{x:280,y:360},{x:520,y:360},{x:520,y:540},{x:280,y:540}] } },
  // Steel post points
  { id: "m-106", sheetId: "sheet-1-1", sectionId: "sec-rooms", name: "Steel Post", mtype: "point", color: "#23394F", geom: { x: 540, y: 300, count: 1 } },
  { id: "m-107", sheetId: "sheet-1-1", sectionId: "sec-rooms", name: "Steel Post", mtype: "point", color: "#23394F", geom: { x: 660, y: 300, count: 1 } },

  /* ===== Sheet 1.2 — First Floor Plan ===== */
  // Exterior walls (lines)
  { id: "m-201", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 (Front)", mtype: "line", color: "#1a47ba", geom: { x1: 220, y1: 200, x2: 860, y2: 200 } },
  { id: "m-202", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 (Right)", mtype: "line", color: "#1a47ba", geom: { x1: 860, y1: 200, x2: 860, y2: 600 } },
  { id: "m-203", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 (Back)",  mtype: "line", color: "#1a47ba", geom: { x1: 860, y1: 600, x2: 220, y2: 600 } },
  { id: "m-204", sheetId: "sheet-1-2", sectionId: "sec-walls-ext", name: "Ext Wall 2x6 (Left)",  mtype: "line", color: "#1a47ba", geom: { x1: 220, y1: 600, x2: 220, y2: 200 } },
  // Interior walls
  { id: "m-205", sheetId: "sheet-1-2", sectionId: "sec-walls-int", name: "Int Wall 2x4", mtype: "line", color: "#e84393", geom: { x1: 540, y1: 200, x2: 540, y2: 600 } },
  { id: "m-206", sheetId: "sheet-1-2", sectionId: "sec-walls-int", name: "Int Wall 2x4", mtype: "line", color: "#e84393", geom: { x1: 540, y1: 410, x2: 860, y2: 410 } },
  // Rooms (areas)
  { id: "m-207", sheetId: "sheet-1-2", sectionId: "sec-rooms", name: "Living Room", mtype: "area", color: "#21ba45", geom: { points: [{x:240,y:220},{x:520,y:220},{x:520,y:580},{x:240,y:580}] } },
  { id: "m-208", sheetId: "sheet-1-2", sectionId: "sec-rooms", name: "Kitchen", mtype: "area", color: "#6c5ce7", geom: { points: [{x:560,y:220},{x:840,y:220},{x:840,y:390},{x:560,y:390}] } },
  // Doors (points)
  { id: "m-209", sheetId: "sheet-1-2", sectionId: "sec-doors", name: "Interior Door 30\"", mtype: "point", color: "#FD7E14", geom: { x: 540, y: 320, count: 1 } },
  { id: "m-210", sheetId: "sheet-1-2", sectionId: "sec-doors", name: "Front Entry Door 36\"", mtype: "point", color: "#FD7E14", geom: { x: 380, y: 200, count: 1 } },
  // Windows (points)
  { id: "m-211", sheetId: "sheet-1-2", sectionId: "sec-windows", name: "DH Window 30x48", mtype: "point", color: "#d63031", geom: { x: 700, y: 200, count: 1 } },
  { id: "m-212", sheetId: "sheet-1-2", sectionId: "sec-windows", name: "DH Window 30x48", mtype: "point", color: "#d63031", geom: { x: 860, y: 320, count: 1 } },

  /* ===== Sheet 1.3 — Rear Elevation ===== */
  // Siding area
  { id: "m-301", sheetId: "sheet-1-3", sectionId: "sec-siding", name: "Vinyl Siding D4", mtype: "area", color: "#808000", geom: { points: [{x:260,y:300},{x:820,y:300},{x:820,y:560},{x:260,y:560}] } },
  // Roof line (gable) — drawn as two area triangles + ridge line
  { id: "m-302", sheetId: "sheet-1-3", sectionId: "sec-roofing", name: "Roof Slope", mtype: "area", color: "#d63031", geom: { points: [{x:240,y:300},{x:540,y:160},{x:840,y:300}] } },
  { id: "m-303", sheetId: "sheet-1-3", sectionId: "sec-roofing", name: "Ridge Cap", mtype: "line", color: "#e84393", geom: { x1: 240, y1: 300, x2: 840, y2: 300 } },
  // Windows on elevation
  { id: "m-304", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "DH Window 36x60", mtype: "point", color: "#1a47ba", geom: { x: 360, y: 400, count: 1 } },
  { id: "m-305", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "DH Window 36x60", mtype: "point", color: "#1a47ba", geom: { x: 540, y: 400, count: 1 } },
  { id: "m-306", sheetId: "sheet-1-3", sectionId: "sec-windows", name: "DH Window 36x60", mtype: "point", color: "#1a47ba", geom: { x: 720, y: 400, count: 1 } }
];



/* --------------------------------------------------------------------
   BLUEPRINT BACKGROUNDS
   Returns an SVG markup string (drawn in the same VIEW_W x VIEW_H space)
   used as a faint architectural backdrop behind the measurements.
   -------------------------------------------------------------------- */
function blueprintMarkup(plan) {
  const wall = '#9fb0c0';
  const thin = '#c4cfda';
  if (plan === "foundation") {
    return `
      <g class="bp" stroke="${wall}" fill="none" stroke-width="2">
        <rect x="230" y="170" width="620" height="400" stroke-width="4"/>
        <rect x="250" y="190" width="580" height="360" stroke="${thin}" stroke-width="1.5"/>
        <line x1="540" y1="170" x2="540" y2="570" stroke="${thin}"/>
        <rect x="270" y="350" width="260" height="200" stroke="${thin}" stroke-dasharray="6 5"/>
        <text x="380" y="455" fill="#aeb9c4" font-size="16" text-anchor="middle">GARAGE</text>
        <text x="690" y="370" fill="#aeb9c4" font-size="16" text-anchor="middle">BASEMENT</text>
        ${gridLines()}
      </g>`;
  }
  if (plan === "floor") {
    return `
      <g class="bp" stroke="${wall}" fill="none" stroke-width="2">
        <rect x="210" y="190" width="660" height="420" stroke-width="4"/>
        <rect x="228" y="208" width="624" height="384" stroke="${thin}" stroke-width="1.5"/>
        <line x1="540" y1="190" x2="540" y2="610" stroke="${thin}"/>
        <line x1="540" y1="410" x2="870" y2="410" stroke="${thin}"/>
        <rect x="368" y="184" width="40" height="12" fill="#dde4ec" stroke="none"/>
        <rect x="688" y="184" width="48" height="12" fill="#dde4ec" stroke="none"/>
        <text x="375" y="420" fill="#aeb9c4" font-size="16" text-anchor="middle">LIVING</text>
        <text x="700" y="320" fill="#aeb9c4" font-size="16" text-anchor="middle">KITCHEN</text>
        <text x="700" y="520" fill="#aeb9c4" font-size="16" text-anchor="middle">BEDROOM</text>
        ${gridLines()}
      </g>`;
  }
  // elevation
  return `
    <g class="bp" stroke="${wall}" fill="none" stroke-width="2">
      <rect x="250" y="290" width="580" height="280" stroke-width="4"/>
      <polygon points="240,300 540,150 840,300" stroke-width="4"/>
      <line x1="540" y1="150" x2="540" y2="300" stroke="${thin}"/>
      <line x1="250" y1="560" x2="830" y2="560" stroke="${wall}" stroke-width="4"/>
      <text x="540" y="610" fill="#aeb9c4" font-size="16" text-anchor="middle">REAR ELEVATION</text>
      ${gridLines()}
    </g>`;
}

// faint dotted grid behind everything
function gridLines() {
  let g = '<g stroke="#e9eef3" stroke-width="1">';
  for (let x = 0; x <= VIEW_W; x += 40) g += `<line x1="${x}" y1="0" x2="${x}" y2="${VIEW_H}"/>`;
  for (let y = 0; y <= VIEW_H; y += 40) g += `<line x1="0" y1="${y}" x2="${VIEW_W}" y2="${y}"/>`;
  g += '</g>';
  return g;
}
