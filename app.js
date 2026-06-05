/* ====================================================================
   PTO Copy/Paste Prototype — Visual Canvas App (vanilla JS + SVG)
   ====================================================================
   State-driven: a single `state` object is the source of truth and the
   canvas / panels are re-rendered from it. Measurements are real SVG
   geometry that can be selected, moved, resized, copied, pasted, edited
   and deleted — across multiple sheets.
   ==================================================================== */

const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  sheets:    JSON.parse(JSON.stringify(SHEETS)),
  sections:  JSON.parse(JSON.stringify(SECTIONS)),
  measures:  JSON.parse(JSON.stringify(MEASUREMENTS)),
  library:   JSON.parse(JSON.stringify(KEY_MEASURE_LIBRARY)),
  activeSheetId: "sheet-1-2",
  selectedIds: new Set(),
  lastSelectedId: null,
  clipboard: [],                 // deep copies (no id/sheetId) + _sourceSheetId
  sheetSearch: "",
  treeSearch: "",
  tool: "select",                // select | move | pan | line | area | point
  view: { x: 0, y: 0, w: VIEW_W, h: VIEW_H },
  expandedSheets: new Set(["sheet-1-2"]),
  lastCanvasCursor: { x: VIEW_W / 2, y: VIEW_H / 2 }, // last known cursor in SVG coords
  ctxPastePoint: null,                                 // SVG point to use for "paste at cursor"
  pasteMode: false,                                    // true after copy → click-to-paste active
  snap: true,                                          // snap-to-grid / endpoints during move & paste
  pendingPaste: null,                                  // staged paste awaiting a collision decision
  history: []                                          // audit log (combine / merge entries)
};

const GRID = 40;                  // grid spacing in user units (matches data.js gridLines)
const SNAP_ENDPOINT_T = 11;       // px tolerance to snap to an endpoint
const SNAP_GRID_T = 7;            // px tolerance to snap to grid
const COLLIDE_T = 18;             // px proximity that counts as "a measurement already here"
const lineTypes = ["line", "beam", "joist"];   // geometries that use {x1,y1,x2,y2}
const isLineGeom = (mtype) => lineTypes.includes(mtype);

let idc = 5000;
const nextId = () => "m-" + (++idc);

// ===== geometry helpers =====
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

function lineFeet(g) { return dist(g.x1, g.y1, g.x2, g.y2) / PX_PER_FOOT; }
function polyAreaPx(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}
function polyFeet2(pts) { return polyAreaPx(pts) / (PX_PER_FOOT * PX_PER_FOOT); }
function centroid(pts) {
  const c = pts.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: c.x / pts.length, y: c.y / pts.length };
}
// raw geometric quantity (numeric) in the measure's native unit
function geomQty(m) {
  if (isLineGeom(m.mtype)) return lineFeet(m.geom);
  if (m.mtype === "area")  return polyFeet2(m.geom.points);
  return m.geom.count || 1;
}
// effective quantity = qtyOverride (set by combine / merge) if present, else geometric
function measureQty(m) {
  return (m.qtyOverride != null) ? m.qtyOverride : geomQty(m);
}
function measureLabel(m) {
  const unit = MTYPE_META[m.mtype].unit;
  const v = measureQty(m);
  if (unit === "EA") return `${Math.round(v)} EA`;
  if (unit === "SF") return `${Math.round(v).toLocaleString()} SF`;
  return `${v.toFixed(1)} LF`;   // LF for line / beam / joist
}
function measureBBox(m) {
  if (isLineGeom(m.mtype)) {
    return { x1: Math.min(m.geom.x1, m.geom.x2), y1: Math.min(m.geom.y1, m.geom.y2),
             x2: Math.max(m.geom.x1, m.geom.x2), y2: Math.max(m.geom.y1, m.geom.y2) };
  }
  if (m.mtype === "area") {
    const xs = m.geom.points.map(p => p.x), ys = m.geom.points.map(p => p.y);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }
  return { x1: m.geom.x - 11, y1: m.geom.y - 11, x2: m.geom.x + 11, y2: m.geom.y + 11 };
}
function offsetGeom(geom, mtype, dx, dy) {
  // line / beam / joist all carry x1,y1,x2,y2 (+ extra metadata we preserve via spread)
  if (isLineGeom(mtype)) return { ...geom, x1: geom.x1 + dx, y1: geom.y1 + dy, x2: geom.x2 + dx, y2: geom.y2 + dy };
  if (mtype === "area")  return { ...geom, points: geom.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...geom, x: geom.x + dx, y: geom.y + dy, count: geom.count };
}
// center point of a geometry (line midpoint / polygon centroid / point itself)
function geomCenter(geom, mtype) {
  if (isLineGeom(mtype)) return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
  if (mtype === "area")  return centroid(geom.points);
  return { x: geom.x, y: geom.y };
}
// center of a group of clipboard items (average of their centers)
function clipboardGroupCenter(clips) {
  const cs = clips.map(c => geomCenter(c.geom, c.mtype));
  const sum = cs.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / cs.length, y: sum.y / cs.length };
}
// current center of the SVG viewport in user units
function viewportCenter() {
  return { x: state.view.x + state.view.w / 2, y: state.view.y + state.view.h / 2 };
}

// ===== derived getters (soft-deleted measures are excluded everywhere) =====
const activeMeasures = () => state.measures.filter(m => m.sheetId === state.activeSheetId && !m.removed);
const measuresOnSheet = (sid) => state.measures.filter(m => m.sheetId === sid && !m.removed);
const getMeasure = (id) => state.measures.find(m => m.id === id);
const orderedActiveIds = () => activeMeasures().map(m => m.id);

// ====================================================================
//  COORDINATE CONVERSION (client px -> SVG user units)
// ====================================================================
function clientToSvg(clientX, clientY) {
  const svg = document.getElementById("draw-svg");
  const pt = svg.createSVGPoint();
  pt.x = clientX; pt.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const p = pt.matrixTransform(m.inverse());
  return { x: p.x, y: p.y };
}
// SVG user units -> client (screen) px — used to position HTML overlays (popover/readout)
function svgToClient(x, y) {
  const svg = document.getElementById("draw-svg");
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const pt = svg.createSVGPoint();
  pt.x = x; pt.y = y;
  const p = pt.matrixTransform(m);
  return { x: p.x, y: p.y };
}
const ft = (px) => px / PX_PER_FOOT;   // user units -> feet

// ====================================================================
//  RENDER — left Sheets sidebar (accordion w/ measurement list)
// ====================================================================
function renderSheets() {
  const list = document.getElementById("sheet-list");
  list.innerHTML = "";
  const q = state.sheetSearch.toLowerCase();

  state.sheets.forEach(sheet => {
    const sheetMeasures = measuresOnSheet(sheet.id);
    const matchSheet = !q || sheet.name.toLowerCase().includes(q) || (sheet.label || "").toLowerCase().includes(q);
    const filteredMeasures = q
      ? sheetMeasures.filter(m => m.name.toLowerCase().includes(q))
      : sheetMeasures;
    if (q && !matchSheet && filteredMeasures.length === 0) return;

    const block = document.createElement("li");
    block.className = "sheet-block" + (sheet.id === state.activeSheetId ? " active" : "");

    const open = q ? true : state.expandedSheets.has(sheet.id);
    const head = document.createElement("div");
    head.className = "sheet-head";
    head.innerHTML = `
      <span class="caret ${open ? "open" : ""}"><i class="fa-solid fa-caret-right"></i></span>
      <i class="fa-regular fa-file sheet-icon"></i>
      <span class="sheet-label">${sheet.name}</span>
      <span class="sheet-count">${sheetMeasures.length}</span>
    `;
    head.title = `${sheet.name} — ${sheet.label}`;
    head.addEventListener("click", (e) => {
      const caretClicked = e.target.closest(".caret");
      if (sheet.id !== state.activeSheetId) {
        switchSheet(sheet.id);
        state.expandedSheets.add(sheet.id);
      } else if (caretClicked) {
        if (state.expandedSheets.has(sheet.id)) state.expandedSheets.delete(sheet.id);
        else state.expandedSheets.add(sheet.id);
        renderSheets();
      } else {
        state.expandedSheets.add(sheet.id);
        renderSheets();
      }
    });
    block.appendChild(head);

    const ul = document.createElement("ul");
    ul.className = "sheet-measures" + (open ? "" : " collapsed");
    (q ? filteredMeasures : sheetMeasures).forEach(m => {
      const li = document.createElement("li");
      li.className = "measure-row" + (state.selectedIds.has(m.id) && sheet.id === state.activeSheetId ? " selected" : "");
      const meta = MTYPE_META[m.mtype];
      li.innerHTML = `
        <i class="${meta.icon} m-icon"></i>
        <span class="m-name" title="${m.name}">${m.name}</span>
        <span class="m-qty">${measureLabel(m)}</span>
        <span class="m-swatch" style="background:${m.color}"></span>
      `;
      li.addEventListener("click", (e) => {
        if (sheet.id !== state.activeSheetId) switchSheet(sheet.id);
        selectMeasure(m.id, e);
      });
      li.addEventListener("dblclick", (e) => { e.stopPropagation(); if (sheet.id !== state.activeSheetId) switchSheet(sheet.id); openEditModal(m.id); });
      // right-click → copy / paste / delete context menu (LEFT panel)
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (sheet.id !== state.activeSheetId) switchSheet(sheet.id);
        if (!state.selectedIds.has(m.id)) { state.selectedIds.clear(); state.selectedIds.add(m.id); state.lastSelectedId = m.id; renderAll(); }
        // left panel has no cursor over the canvas → use last known canvas cursor / viewport center
        openContextMenu(e.clientX, e.clientY, state.lastCanvasCursor || viewportCenter());
      });
      ul.appendChild(li);
    });
    block.appendChild(ul);
    list.appendChild(block);
  });
}

function switchSheet(sheetId) {
  if (sheetId === state.activeSheetId) return;
  state.activeSheetId = sheetId;
  state.selectedIds.clear();
  state.lastSelectedId = null;
  state.expandedSheets.add(sheetId);
  closeContextMenu();
  resetView();
  renderAll();
  const s = state.sheets.find(x => x.id === sheetId);
  showToast(`Switched to ${s.name} — ${s.label}`, "info", "fa-solid fa-file");
}

// ====================================================================
//  RENDER — center SVG canvas
// ====================================================================
function renderCanvas() {
  const svg = document.getElementById("draw-svg");
  const sheet = state.sheets.find(s => s.id === state.activeSheetId);
  svg.setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);

  let inner = blueprintMarkup(sheet.plan);

  // measurements
  activeMeasures().forEach(m => { inner += measureSvg(m); });

  // selection handles / outlines for selected (drawn last = on top)
  activeMeasures().filter(m => state.selectedIds.has(m.id)).forEach(m => { inner += selectionSvg(m); });

  svg.innerHTML = inner;

  // sheet tag + canvas title
  document.getElementById("sheet-tag").textContent = `${sheet.name} · ${sheet.label}`;
  document.getElementById("zoom-label").textContent = Math.round((VIEW_W / state.view.w) * 100) + "%";
}

function measureSvg(m) {
  const sel = state.selectedIds.has(m.id);
  const cp = isCopied(m);
  if (m.mtype === "line") {
    const { x1, y1, x2, y2 } = m.geom;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const label = measureLabel(m);
    return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
      ${cp ? `<line class="copied-outline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` : ""}
      <line class="meas-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <line class="meas-line" stroke="${m.color}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <rect class="meas-label-bg" x="${mx - label.length * 3.6 - 4}" y="${my - 17}" width="${label.length * 7.2 + 8}" height="16" rx="3"/>
      <text class="meas-label" fill="${m.color}" x="${mx}" y="${my - 5}" text-anchor="middle">${label}</text>
    </g>`;
  }
  if (m.mtype === "area") {
    const pts = m.geom.points.map(p => `${p.x},${p.y}`).join(" ");
    const c = centroid(m.geom.points);
    const label = measureLabel(m);
    return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
      ${cp ? `<polygon class="copied-outline" points="${pts}"/>` : ""}
      <polygon class="meas-poly" points="${pts}" fill="${m.color}" stroke="${m.color}"/>
      <rect class="meas-label-bg" x="${c.x - label.length * 3.6 - 4}" y="${c.y - 9}" width="${label.length * 7.2 + 8}" height="16" rx="3"/>
      <text class="meas-label" fill="${m.color}" x="${c.x}" y="${c.y + 3}" text-anchor="middle">${label}</text>
    </g>`;
  }
  if (m.mtype === "beam") {
    const { x1, y1, x2, y2 } = m.geom;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const label = measureLabel(m);
    return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
      ${cp ? `<line class="copied-outline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` : ""}
      <line class="meas-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <line class="meas-beam" stroke="${m.color}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <line class="meas-beam-core" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <rect class="meas-label-bg" x="${mx - label.length * 3.6 - 4}" y="${my - 19}" width="${label.length * 7.2 + 8}" height="16" rx="3"/>
      <text class="meas-label" fill="${m.color}" x="${mx}" y="${my - 7}" text-anchor="middle">${label}</text>
    </g>`;
  }
  if (m.mtype === "joist") {
    const { x1, y1, x2, y2 } = m.geom;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const label = measureLabel(m);
    return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
      ${cp ? `<line class="copied-outline" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>` : ""}
      <line class="meas-line-hit" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <line class="meas-joist-run" stroke="${m.color}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>
      <g stroke="${m.color}">${joistTicks(m.geom)}</g>
      <rect class="meas-label-bg" x="${mx - label.length * 3.6 - 4}" y="${my - 9}" width="${label.length * 7.2 + 8}" height="16" rx="3"/>
      <text class="meas-label" fill="${m.color}" x="${mx}" y="${my + 3}" text-anchor="middle">${label}</text>
    </g>`;
  }
  // point
  const { x, y } = m.geom;
  return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
    ${cp ? `<circle class="copied-outline" cx="${x}" cy="${y}" r="15"/>` : ""}
    <circle class="meas-point-dot" cx="${x}" cy="${y}" r="12" fill="${m.color}"/>
    <text class="point-badge" x="${x}" y="${y + 4}">${measureQty(m)}</text>
  </g>`;
}

// perpendicular tick marks along a joist/rafter run (every ~16px)
function joistTicks(g) {
  const len = dist(g.x1, g.y1, g.x2, g.y2) || 1;
  const ux = (g.x2 - g.x1) / len, uy = (g.y2 - g.y1) / len;   // unit vector along run
  const px = -uy, py = ux;                                     // perpendicular
  const half = 6, step = 16;
  let s = "";
  for (let d = 0; d <= len; d += step) {
    const cx = g.x1 + ux * d, cy = g.y1 + uy * d;
    s += `<line class="joist-tick" x1="${cx - px * half}" y1="${cy - py * half}" x2="${cx + px * half}" y2="${cy + py * half}"/>`;
  }
  return s;
}

function selectionSvg(m) {
  let s = "";
  // Resize/move handles only appear in Move mode (gated editing).
  const showHandles = state.tool === "move" || state.pasteMode;
  if (isLineGeom(m.mtype)) {
    s += `<line class="sel-outline-line" x1="${m.geom.x1}" y1="${m.geom.y1}" x2="${m.geom.x2}" y2="${m.geom.y2}"/>`;
    if (showHandles) {
      s += handle(m.geom.x1, m.geom.y1, m.id, "p1");
      s += handle(m.geom.x2, m.geom.y2, m.id, "p2");
    }
  } else if (m.mtype === "area") {
    const bb = measureBBox(m);
    s += `<rect class="sel-outline" x="${bb.x1 - 4}" y="${bb.y1 - 4}" width="${bb.x2 - bb.x1 + 8}" height="${bb.y2 - bb.y1 + 8}"/>`;
    if (showHandles) m.geom.points.forEach((p, i) => { s += handle(p.x, p.y, m.id, "v" + i); });
  } else {
    s += `<circle class="sel-outline" cx="${m.geom.x}" cy="${m.geom.y}" r="17"/>`;
    if (showHandles) s += handle(m.geom.x, m.geom.y - 17, m.id, "pt", true);
  }
  return s;
}
function handle(x, y, mid, h, move) {
  return `<circle class="handle ${move ? "midmove" : ""}" data-mid="${mid}" data-handle="${h}" cx="${x}" cy="${y}" r="6"/>`;
}

// ====================================================================
//  RENDER — right Takeoff panel = KEY MEASURE LIBRARY (catalog of TYPES)
//  Shows measurement TYPES grouped by category folder. These are
//  templates — no quantities, no copy/paste (read-only catalog).
// ====================================================================
function renderTree() {
  const tree = document.getElementById("takeoff-tree");
  tree.innerHTML = "";
  const q = state.treeSearch.toLowerCase();

  state.library.forEach(folder => {
    const matchFolder = !q || folder.name.toLowerCase().includes(q);
    const types = q
      ? folder.types.filter(t => t.name.toLowerCase().includes(q) || matchFolder)
      : folder.types;
    if (q && !matchFolder && types.length === 0) return;

    const secEl = document.createElement("div");
    secEl.className = "section";
    const expanded = q ? true : folder.expanded;

    const header = document.createElement("div");
    header.className = "section-header";
    header.innerHTML = `
      <span class="caret ${expanded ? "open" : ""}"><i class="fa-solid fa-caret-right"></i></span>
      <i class="fa-regular fa-folder folder-icon"></i>
      <span class="section-name">${folder.name}</span>
      <span class="section-count">${folder.types.length}</span>
    `;
    header.addEventListener("click", () => { if (q) return; folder.expanded = !folder.expanded; renderTree(); });
    secEl.appendChild(header);

    const itemsEl = document.createElement("div");
    itemsEl.className = "section-items" + (expanded ? "" : " collapsed");
    if (expanded) {
      types.forEach(t => {
        const meta = MTYPE_META[t.mtype];
        const row = document.createElement("div");
        row.className = "item-row lib-row";
        row.innerHTML = `
          <i class="${meta.icon} item-icon" title="${meta.label}"></i>
          <span class="item-name" title="${t.name}">${t.name}</span>
          <span class="item-color" style="background:${t.color}"></span>
        `;
        row.title = `${t.name} · ${meta.label} key measure type`;
        itemsEl.appendChild(row);
      });
    }
    secEl.appendChild(itemsEl);
    tree.appendChild(secEl);
  });

  if (!tree.children.length) {
    tree.innerHTML = `<div class="section-empty" style="padding-left:20px">No key measure types match "${state.treeSearch}".</div>`;
  }
}

// ====================================================================
//  SELECTION
// ====================================================================
function selectMeasure(id, e) {
  e = e || {};
  if (e.shiftKey && state.lastSelectedId) {
    const ordered = orderedActiveIds();
    const a = ordered.indexOf(state.lastSelectedId), b = ordered.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(e.ctrlKey || e.metaKey)) state.selectedIds.clear();
      for (let i = lo; i <= hi; i++) state.selectedIds.add(ordered[i]);
    } else state.selectedIds.add(id);
  } else if (e.ctrlKey || e.metaKey) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.lastSelectedId = id;
  } else {
    state.selectedIds.clear();
    state.selectedIds.add(id);
    state.lastSelectedId = id;
  }
  closeContextMenu();
  renderAll();
}
function clearSelection() {
  if (!state.selectedIds.size) return;
  state.selectedIds.clear();
  state.lastSelectedId = null;
  renderAll();
}
function selectAll() {
  orderedActiveIds().forEach(id => state.selectedIds.add(id));
  renderAll();
}

// ====================================================================
//  CLIPBOARD
// ====================================================================
const isCopied = (m) => state.clipboard.some(c => c._sourceId === m.id && c._sourceSheetId === m.sheetId);

function copySelection() {
  if (!state.selectedIds.size) { showToast("Nothing selected to copy", "error", "fa-solid fa-triangle-exclamation"); return; }
  const ids = orderedActiveIds().filter(id => state.selectedIds.has(id));
  state.clipboard = ids.map(id => {
    const m = getMeasure(id);
    return {
      _sourceId: m.id, _sourceSheetId: m.sheetId,
      name: m.name, mtype: m.mtype, color: m.color, sectionId: m.sectionId,
      linearType: m.linearType, use: m.use,
      geom: JSON.parse(JSON.stringify(m.geom))
    };
  });
  updateClipboardIndicator();
  setPasteMode(true);            // enter click-to-paste mode
  renderCanvas();
  showToast(`${state.clipboard.length} measurement${state.clipboard.length > 1 ? "s" : ""} copied — click on the canvas to paste, Esc to cancel`, "success", "fa-solid fa-copy");
}

/**
 * Enter / exit paste mode (click-to-paste). Updates the canvas cursor and ghost.
 */
function setPasteMode(on) {
  state.pasteMode = !!on;
  const svg = document.getElementById("draw-svg");
  if (state.pasteMode) {
    if (svg && state.tool === "select") svg.style.cursor = "copy";
  } else {
    removePasteGhost();
    if (svg) svg.style.cursor = state.tool === "pan" ? "grab" : (state.tool === "move" ? "move" : (state.tool === "select" ? "default" : "crosshair"));
  }
  updateModeIndicator();
  updateStatusBar();
}

/**
 * Clear the clipboard and exit paste mode (used by Esc).
 */
function clearClipboard() {
  state.clipboard = [];
  setPasteMode(false);
  updateClipboardIndicator();
  renderCanvas();               // drop the "copied" source highlight
}

/**
 * Paste clipboard items.
 * @param {"original"|"cursor"} mode
 *   - "original": keep original coords (same-sheet nudged by 36px so the copy is visible)
 *   - "cursor":   center the copied group at `pt` (or last known canvas cursor)
 * @param {{x:number,y:number}|null} pt  target point in SVG user units (cursor mode)
 */
function pasteClipboard(mode = "original", pt = null) {
  if (!state.clipboard.length) { showToast("Clipboard is empty", "error", "fa-solid fa-triangle-exclamation"); return; }

  // For cursor mode, work out a single group offset so relative positions are kept
  let groupDx = 0, groupDy = 0;
  if (mode === "cursor") {
    let target = pt || state.lastCanvasCursor || viewportCenter();
    if (state.snap) { const sn = snapValue(target, null); if (sn) target = sn; }
    const gc = clipboardGroupCenter(state.clipboard);
    groupDx = target.x - gc.x;
    groupDy = target.y - gc.y;
  }

  // Build the list of items to be pasted, computing final geometry + any collision.
  const items = state.clipboard.map(clip => {
    const sameSheet = clip._sourceSheetId === state.activeSheetId;
    let dx, dy;
    if (mode === "cursor") {
      dx = groupDx; dy = groupDy;
    } else {
      // "Paste at Original Location" → EXACT 1:1 coordinates (no offset).
      dx = 0; dy = 0;
    }
    const geom = offsetGeom(JSON.parse(JSON.stringify(clip.geom)), clip.mtype, dx, dy);
    const collideId = findCollision(geom, clip.mtype, null);
    return { clip, dx, dy, geom, collideId, sameSheet };
  });

  const anyCollision = items.some(it => it.collideId);
  if (anyCollision) {
    // Stage the paste and ask the user how to resolve overlaps.
    const anchor = mode === "cursor"
      ? (pt || state.lastCanvasCursor || viewportCenter())
      : geomCenter(items[0].geom, items[0].clip.mtype);
    state.pendingPaste = { mode, items, anchor };
    showCollidePopover(anchor, items.filter(it => it.collideId).length);
    return;
  }

  finalizePaste("separate", items, mode);
}

// Find an existing active measurement of the same type whose center is within
// COLLIDE_T of the given geometry. Returns its id, or null.
function findCollision(geom, mtype, excludeIds) {
  const c = geomCenter(geom, mtype);
  let hit = null;
  activeMeasures().forEach(m => {
    if (m.mtype !== mtype) return;
    if (excludeIds && excludeIds.has(m.id)) return;
    const mc = geomCenter(m.geom, m.mtype);
    if (dist(c.x, c.y, mc.x, mc.y) <= COLLIDE_T) hit = m.id;
  });
  return hit;
}

// Actually create / merge the pasted items.
//   decision: "separate" | "merge" | "cancel"
function finalizePaste(decision, items, mode) {
  items = items || (state.pendingPaste && state.pendingPaste.items);
  mode = mode || (state.pendingPaste && state.pendingPaste.mode) || "original";
  hideCollidePopover();
  state.pendingPaste = null;
  if (!items || decision === "cancel") {
    showToast("Paste cancelled", "", "fa-solid fa-ban");
    return;
  }

  const newIds = [];
  let merged = 0;
  items.forEach(it => {
    const clip = it.clip;
    if (decision === "merge" && it.collideId) {
      // Merge quantities into the existing measurement at that location.
      const target = getMeasure(it.collideId);
      if (target) {
        const incomingQty = measureQty({ mtype: clip.mtype, geom: it.geom });
        const before = measureQty(target);
        target.qtyOverride = before + incomingQty;
        state.history.push({ type: "merge", ts: Date.now(), keptId: target.id,
          detail: `Merged a pasted ${MTYPE_META[clip.mtype].label} into ${target.name}: ${before.toFixed(1)} + ${incomingQty.toFixed(1)} ${MTYPE_META[clip.mtype].unit}` });
        merged++;
        return;
      }
    }
    // Place separately → create a brand-new measurement.
    const sectionId = state.sections.some(s => s.id === clip.sectionId) ? clip.sectionId : state.sections[0].id;
    const nm = {
      id: nextId(),
      sheetId: state.activeSheetId,
      sectionId,
      name: it.sameSheet ? clip.name + " (copy)" : clip.name,
      mtype: clip.mtype,
      color: clip.color,
      geom: it.geom,
      linearType: clip.linearType,
      use: clip.use
    };
    state.measures.push(nm);
    newIds.push(nm.id);
    const sec = state.sections.find(s => s.id === sectionId);
    if (sec) sec.expanded = true;
  });

  if (newIds.length) { state.selectedIds = new Set(newIds); state.lastSelectedId = newIds[newIds.length - 1]; }
  renderAll();
  newIds.forEach(id => {
    const g = document.querySelector(`.meas[data-mid="${id}"]`);
    if (g) g.classList.add("just-pasted");
  });

  const sheet = state.sheets.find(s => s.id === state.activeSheetId);
  const where = mode === "cursor" ? "at cursor" : "at original location";
  const icon = mode === "cursor" ? "fa-solid fa-location-crosshairs" : "fa-solid fa-paste";
  setPasteMode(true);
  let msg;
  if (merged && newIds.length) msg = `Merged ${merged} · placed ${newIds.length} ${where} on ${sheet.name}`;
  else if (merged) msg = `Merged ${merged} measurement${merged > 1 ? "s" : ""} into existing — quantities combined`;
  else msg = `${newIds.length} measurement${newIds.length > 1 ? "s" : ""} pasted ${where} on ${sheet.name} — keep clicking to place more, Esc to finish`;
  showToast(msg, "success", icon);
}

// ---- collision popover (inline, near the paste location) ----
function showCollidePopover(anchorSvgPt, nCollide) {
  const pop = document.getElementById("collide-popover");
  if (!pop) return;
  const c = svgToClient(anchorSvgPt.x, anchorSvgPt.y);
  // popover is position:fixed → use viewport (client) coordinates directly
  let left = c.x + 14, top = c.y + 14;
  left = Math.max(8, Math.min(left, window.innerWidth - 284));
  top = Math.max(8, Math.min(top, window.innerHeight - 190));
  pop.style.left = left + "px";
  pop.style.top = top + "px";
  const sub = document.getElementById("collide-sub");
  if (sub) sub.textContent = `${nCollide} pasted item${nCollide > 1 ? "s" : ""} overlap an existing measurement at this location.`;
  pop.classList.add("show");
}
function hideCollidePopover() {
  const pop = document.getElementById("collide-popover");
  if (pop) pop.classList.remove("show");
}

function deleteSelection() {
  if (!state.selectedIds.size) { showToast("Nothing selected to delete", "error", "fa-solid fa-triangle-exclamation"); return; }
  const n = state.selectedIds.size;
  state.measures = state.measures.filter(m => !state.selectedIds.has(m.id));
  state.selectedIds.clear();
  state.lastSelectedId = null;
  closeContextMenu();
  renderAll();
  showToast(`${n} measurement${n > 1 ? "s" : ""} deleted`, "success", "fa-solid fa-trash");
}

function updateClipboardIndicator() {
  const ind = document.getElementById("clipboard-indicator");
  document.getElementById("clip-count").textContent = state.clipboard.length;
  ind.classList.toggle("active", state.clipboard.length > 0);
}

// ====================================================================
//  POINTER INTERACTION (select / move / resize / rubber-band / pan)
// ====================================================================
let drag = null;   // { mode, ... }

function onPointerDown(e) {
  const svg = document.getElementById("draw-svg");
  const p = clientToSvg(e.clientX, e.clientY);

  // PAN: pan tool, middle button, or space held
  if (state.tool === "pan" || e.button === 1 || spaceDown) {
    drag = { mode: "pan", startClient: { x: e.clientX, y: e.clientY }, startView: { ...state.view } };
    svg.classList.add("panning");
    svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  // CREATE tools
  if (state.tool === "line" || state.tool === "area" || state.tool === "point") {
    createMeasureAt(p, state.tool);
    setTool("select");
    return;
  }

  // PASTE MODE: a left-click anywhere on the canvas drops a copy at the cursor.
  // Clipboard is kept so the user can keep clicking to place more (Esc to finish).
  if (state.pasteMode && state.clipboard.length) {
    pasteClipboard("cursor", p);
    return;
  }

  const mod = e.shiftKey || e.ctrlKey || e.metaKey;

  // RESIZE handle? (resize is only active in MOVE mode; handles aren't shown otherwise)
  const handleEl = e.target.closest(".handle");
  if (handleEl && state.tool === "move" && !mod) {
    const mid = handleEl.dataset.mid, h = handleEl.dataset.handle;
    const m = getMeasure(mid);
    drag = { mode: "resize", mid, handle: h, start: p,
             snapshot: JSON.parse(JSON.stringify(m.geom)), selSet: new Set([mid]) };
    svg.setPointerCapture(e.pointerId);
    return;
  }

  // MEASUREMENT body with a modifier → multi-select toggle / range (works in any tool)
  const g = e.target.closest(".meas");
  if (g && mod) { selectMeasure(g.dataset.mid, e); return; }

  // MEASUREMENT body, no modifier
  if (g) {
    const mid = g.dataset.mid;
    if (state.tool === "move") {
      // MOVE mode → select (if needed) then begin dragging all selected
      if (!state.selectedIds.has(mid)) {
        state.selectedIds.clear(); state.selectedIds.add(mid); state.lastSelectedId = mid; renderAll();
      }
      beginMove(p, e.pointerId);
      return;
    }
    // SELECT mode → click selects only; dragging-to-move is gated OFF (use the Move tool)
    state.selectedIds.clear(); state.selectedIds.add(mid); state.lastSelectedId = mid;
    closeContextMenu(); renderAll();
    return;
  }

  // EMPTY canvas (or modifier-drag) → rubber-band box select.
  // Ctrl/Shift held = additive (keeps the current selection).
  if (!mod) { state.selectedIds.clear(); state.lastSelectedId = null; renderAll(); }
  drag = { mode: "band", start: p, additive: mod };
  svg.setPointerCapture(e.pointerId);
  closeContextMenu();
}

// Begin a move-drag of all currently selected measurements
function beginMove(p, pointerId) {
  const svg = document.getElementById("draw-svg");
  const snap = {};
  state.selectedIds.forEach(id => { snap[id] = JSON.parse(JSON.stringify(getMeasure(id).geom)); });
  const primary = getMeasure(state.lastSelectedId) || getMeasure([...state.selectedIds][0]);
  drag = { mode: "move", start: p, snapshot: snap, moved: false,
           anchorStart: anchorPoint(primary), selSet: new Set(state.selectedIds) };
  if (pointerId != null) { try { svg.setPointerCapture(pointerId); } catch (_) {} }
}
// representative point of a measure used as the snap anchor while moving
function anchorPoint(m) {
  if (!m) return { x: 0, y: 0 };
  if (isLineGeom(m.mtype)) return { x: m.geom.x1, y: m.geom.y1 };
  if (m.mtype === "area")  return { x: m.geom.points[0].x, y: m.geom.points[0].y };
  return { x: m.geom.x, y: m.geom.y };
}

function onPointerMove(e) {
  if (!drag) return;
  const p = clientToSvg(e.clientX, e.clientY);

  if (drag.mode === "pan") {
    const svg = document.getElementById("draw-svg");
    const rect = svg.getBoundingClientRect();
    const scaleX = state.view.w / rect.width, scaleY = state.view.h / rect.height;
    state.view.x = drag.startView.x - (e.clientX - drag.startClient.x) * scaleX;
    state.view.y = drag.startView.y - (e.clientY - drag.startClient.y) * scaleY;
    document.getElementById("draw-svg").setAttribute("viewBox", `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
    return;
  }

  if (drag.mode === "move") {
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
    // SNAP the moved anchor point to nearby endpoints / grid
    let snapInfo = null;
    if (state.snap) {
      const anchorNow = { x: drag.anchorStart.x + dx, y: drag.anchorStart.y + dy };
      const sn = snapValue(anchorNow, drag.selSet);
      if (sn) {
        dx += sn.x - anchorNow.x;
        dy += sn.y - anchorNow.y;
        snapInfo = sn;
      }
    }
    Object.keys(drag.snapshot).forEach(id => {
      const m = getMeasure(id);
      m.geom = offsetGeom(drag.snapshot[id], m.mtype, dx, dy);
    });
    renderCanvas();
    if (snapInfo) showSnapMarker(snapInfo); else hideSnapMarker();
    updateCoordReadout({ x: drag.anchorStart.x + dx, y: drag.anchorStart.y + dy }, dx, dy);
    return;
  }

  if (drag.mode === "resize") {
    const m = getMeasure(drag.mid);
    let np = p, snapInfo = null;
    if (state.snap) {
      const sn = snapValue(p, drag.selSet);
      if (sn) { np = sn; snapInfo = sn; }
    }
    if (isLineGeom(m.mtype)) {
      if (drag.handle === "p1") { m.geom.x1 = np.x; m.geom.y1 = np.y; }
      else { m.geom.x2 = np.x; m.geom.y2 = np.y; }
    } else if (m.mtype === "area") {
      const i = parseInt(drag.handle.slice(1), 10);
      m.geom.points[i] = { x: np.x, y: np.y };
    } else {
      m.geom.x = np.x; m.geom.y = np.y + 17;   // 'pt' move handle sits above the dot
    }
    renderCanvas();
    if (snapInfo) showSnapMarker(snapInfo); else hideSnapMarker();
    updateCoordReadout(np, null, null);
    return;
  }

  if (drag.mode === "band") {
    drawRubberBand(drag.start, p);
    return;
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const svg = document.getElementById("draw-svg");
  try { svg.releasePointerCapture(e.pointerId); } catch (_) {}

  if (drag.mode === "pan") { svg.classList.remove("panning"); drag = null; return; }

  if (drag.mode === "move") {
    hideSnapMarker(); hideCoordReadout();
    if (drag.moved) {
      renderAll();
      const n = state.selectedIds.size;
      showToast(`Moved ${n} measurement${n > 1 ? "s" : ""}`, "info", "fa-solid fa-up-down-left-right");
    }
    drag = null;
    return;
  }

  if (drag.mode === "resize") {
    hideSnapMarker(); hideCoordReadout();
    renderAll();
    showToast(`Resized — ${measureLabel(getMeasure(drag.mid))}`, "info", "fa-solid fa-up-right-and-down-left-from-center");
    drag = null;
    return;
  }

  if (drag.mode === "band") {
    const p = clientToSvg(e.clientX, e.clientY);
    const box = { x1: Math.min(drag.start.x, p.x), y1: Math.min(drag.start.y, p.y),
                  x2: Math.max(drag.start.x, p.x), y2: Math.max(drag.start.y, p.y) };
    removeRubberBand();
    // only treat as band-select if dragged a meaningful distance
    if (Math.abs(box.x2 - box.x1) > 4 || Math.abs(box.y2 - box.y1) > 4) {
      if (!drag.additive) state.selectedIds.clear();
      activeMeasures().forEach(m => {
        const bb = measureBBox(m);
        const intersects = !(bb.x2 < box.x1 || bb.x1 > box.x2 || bb.y2 < box.y1 || bb.y1 > box.y2);
        if (intersects) state.selectedIds.add(m.id);
      });
      if (state.selectedIds.size) state.lastSelectedId = [...state.selectedIds][state.selectedIds.size - 1];
      renderAll();
    }
    drag = null;
    return;
  }
  drag = null;
}

function drawRubberBand(a, b) {
  const svg = document.getElementById("draw-svg");
  let r = document.getElementById("rubber");
  if (!r) {
    r = document.createElementNS(SVG_NS, "rect");
    r.id = "rubber"; r.setAttribute("class", "rubber-band");
    svg.appendChild(r);
  }
  r.setAttribute("x", Math.min(a.x, b.x));
  r.setAttribute("y", Math.min(a.y, b.y));
  r.setAttribute("width", Math.abs(b.x - a.x));
  r.setAttribute("height", Math.abs(b.y - a.y));
}
function removeRubberBand() { const r = document.getElementById("rubber"); if (r) r.remove(); }

// ====================================================================
//  SNAPPING — endpoints of other measures (priority) then the grid
// ====================================================================
// Collect candidate snap points (endpoints / vertices / point centers)
// from every active measure that is NOT part of the current drag set.
function getSnapTargets(excludeIds) {
  const pts = [];
  activeMeasures().forEach(m => {
    if (excludeIds && excludeIds.has(m.id)) return;
    if (isLineGeom(m.mtype)) {
      pts.push({ x: m.geom.x1, y: m.geom.y1 }, { x: m.geom.x2, y: m.geom.y2 },
               { x: (m.geom.x1 + m.geom.x2) / 2, y: (m.geom.y1 + m.geom.y2) / 2 });
    } else if (m.mtype === "area") {
      m.geom.points.forEach(p => pts.push({ x: p.x, y: p.y }));
    } else {
      pts.push({ x: m.geom.x, y: m.geom.y });
    }
  });
  return pts;
}
// Return a snapped point {x,y,kind} for `p`, or null if nothing within tolerance.
// Endpoint snapping wins; grid snapping is the fallback.
function snapValue(p, excludeIds) {
  // 1) endpoint / vertex snap
  let best = null, bestD = SNAP_ENDPOINT_T;
  getSnapTargets(excludeIds).forEach(t => {
    const d = dist(p.x, p.y, t.x, t.y);
    if (d < bestD) { bestD = d; best = { x: t.x, y: t.y, kind: "endpoint" }; }
  });
  if (best) return best;
  // 2) grid snap
  const gx = Math.round(p.x / GRID) * GRID, gy = Math.round(p.y / GRID) * GRID;
  if (Math.abs(p.x - gx) <= SNAP_GRID_T && Math.abs(p.y - gy) <= SNAP_GRID_T) {
    return { x: gx, y: gy, kind: "grid" };
  }
  return null;
}
// Draw the pulsing snap indicator at the snapped location.
function showSnapMarker(sn) {
  const svg = document.getElementById("draw-svg");
  if (!svg) return;
  let g = document.getElementById("snap-indicator");
  if (!g) {
    g = document.createElementNS(SVG_NS, "g");
    g.id = "snap-indicator";
    g.setAttribute("pointer-events", "none");
    svg.appendChild(g);
  }
  const cls = sn.kind === "endpoint" ? "snap-marker pulse" : "snap-marker grid";
  g.innerHTML =
    `<line class="snap-cross ${sn.kind}" x1="${sn.x - 10}" y1="${sn.y}" x2="${sn.x + 10}" y2="${sn.y}"/>
     <line class="snap-cross ${sn.kind}" x1="${sn.x}" y1="${sn.y - 10}" x2="${sn.x}" y2="${sn.y + 10}"/>
     <circle class="${cls}" cx="${sn.x}" cy="${sn.y}" r="${sn.kind === "endpoint" ? 7 : 5}"/>`;
}
function hideSnapMarker() { const g = document.getElementById("snap-indicator"); if (g) g.remove(); }

// ====================================================================
//  COORDINATE READOUT — live X/Y (ft) + delta while moving / resizing
// ====================================================================
function updateCoordReadout(svgPt, dx, dy) {
  const el = document.getElementById("coord-readout");
  if (!el) return;
  const c = svgToClient(svgPt.x, svgPt.y);
  const wrap = document.getElementById("canvas-sheet-wrap");
  const wr = wrap.getBoundingClientRect();
  el.style.left = (c.x - wr.left + 14) + "px";
  el.style.top = (c.y - wr.top - 14) + "px";
  let html = `<span>X ${ft(svgPt.x).toFixed(1)}′ · Y ${ft(svgPt.y).toFixed(1)}′</span>`;
  if (dx != null && dy != null) {
    const d = ft(Math.hypot(dx, dy));
    html += `<span class="cr-delta">Δ ${d.toFixed(1)}′ from start</span>`;
  }
  el.innerHTML = html;
  el.classList.add("show");
}
function hideCoordReadout() { const el = document.getElementById("coord-readout"); if (el) el.classList.remove("show"); }

// Right-click on canvas
function onCanvasContextMenu(e) {
  e.preventDefault();
  const g = e.target.closest(".meas");
  if (g) {
    const mid = g.dataset.mid;
    if (!state.selectedIds.has(mid)) { state.selectedIds.clear(); state.selectedIds.add(mid); state.lastSelectedId = mid; renderAll(); }
  } else {
    clearSelection();
  }
  const svgPt = clientToSvg(e.clientX, e.clientY);
  state.lastCanvasCursor = svgPt;
  openContextMenu(e.clientX, e.clientY, svgPt);
}
// Double-click on canvas measurement → edit
function onCanvasDblClick(e) {
  const g = e.target.closest(".meas");
  if (g) openEditModal(g.dataset.mid);
}

// ====================================================================
//  CREATE new measurement (draw tools)
// ====================================================================
function createMeasureAt(p, type) {
  const sectionByType = { line: "sec-walls-ext", area: "sec-rooms", point: "sec-windows" };
  const colorByType = { line: "#1a47ba", area: "#21ba45", point: "#d63031" };
  let geom, name;
  if (type === "line") { geom = { x1: p.x - 90, y1: p.y, x2: p.x + 90, y2: p.y }; name = "New Line"; }
  else if (type === "area") { geom = { points: [{x:p.x-90,y:p.y-60},{x:p.x+90,y:p.y-60},{x:p.x+90,y:p.y+60},{x:p.x-90,y:p.y+60}] }; name = "New Area"; }
  else { geom = { x: p.x, y: p.y, count: 1 }; name = "New Point"; }
  const m = { id: nextId(), sheetId: state.activeSheetId, sectionId: sectionByType[type], name, mtype: type, color: colorByType[type], geom };
  state.measures.push(m);
  const sec = state.sections.find(s => s.id === m.sectionId); if (sec) sec.expanded = true;
  state.selectedIds = new Set([m.id]); state.lastSelectedId = m.id;
  renderAll();
  showToast(`Added ${MTYPE_META[type].label} measurement`, "success", MTYPE_META[type].icon);
}

// ====================================================================
//  CONTEXT MENU
// ====================================================================
function openContextMenu(x, y, pastePoint) {
  const menu = document.getElementById("context-menu");
  const hasSel = state.selectedIds.size > 0;
  const hasClip = state.clipboard.length > 0;
  // remember where a "Paste at Cursor" should land (canvas: exact cursor;
  // left-panel: last known canvas cursor; fallback: viewport center)
  state.ctxPastePoint = pastePoint || state.lastCanvasCursor || viewportCenter();
  setCtx("ctx-copy", hasSel);
  setCtx("ctx-paste-cursor", hasClip); setCtx("ctx-paste", hasClip);
  setCtx("ctx-edit", state.selectedIds.size === 1); setCtx("ctx-delete", hasSel);
  const n = state.selectedIds.size;
  const clipN = state.clipboard.length;
  const clipSuffix = clipN > 1 ? ` ${clipN} items` : "";
  document.querySelector("#ctx-copy .ctx-label").textContent = n > 1 ? `Copy ${n} items` : "Copy";
  document.querySelector("#ctx-delete .ctx-label").textContent = n > 1 ? `Delete ${n} items` : "Delete";
  document.querySelector("#ctx-paste-cursor .ctx-label").textContent = `Paste${clipSuffix} at Cursor`;
  document.querySelector("#ctx-paste .ctx-label").textContent = `Paste${clipSuffix} at Original Location`;
  menu.classList.add("open");
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + "px";
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + "px";
}
function setCtx(id, on) { document.getElementById(id).classList.toggle("disabled", !on); }
function closeContextMenu() { document.getElementById("context-menu").classList.remove("open"); }

// ====================================================================
//  EDIT MODAL
// ====================================================================
function openEditModal(id) {
  const m = getMeasure(id);
  if (!m) return;
  closeContextMenu();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const computed = m.mtype !== "point";
  overlay.innerHTML = `
    <div class="modal-box">
      <h4>Edit Measurement</h4>
      <div class="modal-sub">${MTYPE_META[m.mtype].label} &middot; ${measureLabel(m)}</div>

      <label>Name</label>
      <input type="text" id="edit-name" value="${(m.name || "").replace(/"/g, "&quot;")}" autofocus>

      <div class="modal-row">
        <div>
          <label>Type</label>
          <select id="edit-type">
            <option value="line"  ${m.mtype === "line"  ? "selected" : ""}>Line (Linear)</option>
            <option value="area"  ${m.mtype === "area"  ? "selected" : ""}>Area (Polygon)</option>
            <option value="point" ${m.mtype === "point" ? "selected" : ""}>Point (Count)</option>
          </select>
        </div>
        <div>
          <label>${computed ? "Value (auto)" : "Count"}</label>
          <input type="${computed ? "text" : "number"}" id="edit-value"
                 value="${computed ? measureLabel(m) : (m.geom.count || 1)}"
                 ${computed ? "disabled" : 'min="1" step="1"'}>
        </div>
      </div>
      ${computed ? `<div style="font-size:10.5px;color:#9aa7b3;margin-top:5px;">Auto-calculated from the drawing — drag the handles on the canvas to resize.</div>` : ""}

      <label>Color</label>
      <div class="color-picks" id="edit-colors">
        ${COLOR_SWATCHES.map(c => `<span class="color-pick ${c.toLowerCase() === m.color.toLowerCase() ? "selected" : ""}" data-color="${c}" style="background:${c}"></span>`).join("")}
      </div>

      <div class="modal-btns">
        <button class="cancel">Cancel</button>
        <button class="primary">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  let color = m.color;
  const nameInput = overlay.querySelector("#edit-name");
  nameInput.focus(); nameInput.select();
  overlay.querySelectorAll(".color-pick").forEach(sw => sw.addEventListener("click", () => {
    overlay.querySelectorAll(".color-pick").forEach(s => s.classList.remove("selected"));
    sw.classList.add("selected"); color = sw.dataset.color;
  }));

  const close = () => overlay.remove();
  const save = () => {
    const name = overlay.querySelector("#edit-name").value.trim();
    if (!name) { nameInput.style.borderColor = "#ba2121"; nameInput.focus(); return; }
    const newType = overlay.querySelector("#edit-type").value;
    if (newType !== m.mtype) { m.geom = convertGeom(m, newType); m.mtype = newType; }
    if (m.mtype === "point") {
      const v = parseInt(overlay.querySelector("#edit-value").value, 10);
      m.geom.count = (isNaN(v) || v < 1) ? 1 : v;
    }
    m.name = name; m.color = color;
    close(); renderAll();
    showToast(`Updated "${name}"`, "success", "fa-solid fa-pen");
  };
  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.querySelector(".primary").addEventListener("click", save);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT") save();
    if (e.key === "Escape") close();
  });
}

// convert geometry when type changes in the modal
function convertGeom(m, newType) {
  const bb = measureBBox(m);
  const cx = (bb.x1 + bb.x2) / 2, cy = (bb.y1 + bb.y2) / 2;
  if (newType === "point") return { x: cx, y: cy, count: 1 };
  if (newType === "line") {
    if (m.mtype === "area") { const pts = m.geom.points; return { x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y }; }
    return { x1: cx - 90, y1: cy, x2: cx + 90, y2: cy };               // from point
  }
  // to area
  if (m.mtype === "line") {
    const { x1, y1, x2, y2 } = m.geom;
    return { points: [{x:x1,y:y1-30},{x:x2,y:y2-30},{x:x2,y:y2+30},{x:x1,y:y1+30}] };
  }
  return { points: [{x:cx-80,y:cy-60},{x:cx+80,y:cy-60},{x:cx+80,y:cy+60},{x:cx-80,y:cy+60}] }; // from point
}

// ====================================================================
//  COMBINE SAME KM  (merge several measurements of the same Key Measure)
// ====================================================================
const normName = (s) => (s || "").trim().toLowerCase();

function combineSameKM() {
  const ms = [...state.selectedIds].map(getMeasure).filter(m => m && !m.removed);
  if (ms.length < 2) { showToast("Select 2 or more measurements to combine", "error", "fa-solid fa-triangle-exclamation"); return; }

  // 1) KM names must match
  const names = ms.map(m => normName(m.name));
  if (new Set(names).size > 1) { showCantCombineModal(ms); return; }

  // 2) names match → check whether other attributes differ
  const attrsDiffer =
    new Set(ms.map(m => (m.color || "").toLowerCase())).size > 1 ||
    new Set(ms.map(m => m.sectionId)).size > 1 ||
    new Set(ms.map(m => m.linearType || "basic")).size > 1 ||
    new Set(ms.map(m => normName(m.use))).size > 1;

  if (attrsDiffer) { showConflictModal(ms); return; }

  // 3) clean match → combine straight away using the first measure's attributes
  const f = ms[0];
  performCombine(ms, { color: f.color, sectionId: f.sectionId, linearType: f.linearType || "basic", use: f.use || "" });
}

// Merge `ms` into the first selected measure; soft-delete the rest; log an audit entry.
function performCombine(ms, attrs) {
  const kept = ms[0];
  const others = ms.slice(1);
  const totalQty = ms.reduce((sum, m) => sum + measureQty(m), 0);
  const removedDetail = others.map(m => `${m.name} (${measureQty(m).toFixed(1)} ${MTYPE_META[m.mtype].unit})`);

  kept.qtyOverride = (attrs && attrs.qtyOverride != null) ? attrs.qtyOverride : totalQty;
  if (attrs) {
    if (attrs.color) kept.color = attrs.color;
    if (attrs.sectionId) kept.sectionId = attrs.sectionId;
    if (attrs.linearType) kept.linearType = attrs.linearType;
    if (attrs.use != null) kept.use = attrs.use;
  }
  others.forEach(m => { m.removed = true; });

  state.history.push({
    type: "combine", ts: Date.now(), keptId: kept.id,
    removedIds: others.map(m => m.id),
    detail: `Combined ${ms.length} "${kept.name}" measurements → ${MTYPE_META[kept.mtype].unit === "EA" ? Math.round(kept.qtyOverride) : kept.qtyOverride.toFixed(1)} ${MTYPE_META[kept.mtype].unit} (absorbed: ${removedDetail.join(", ")})`
  });

  state.selectedIds = new Set([kept.id]);
  state.lastSelectedId = kept.id;
  renderAll();
  showToast(`Combined ${ms.length} measurements into "${kept.name}" — quantities summed & ${others.length} archived`, "success", "fa-solid fa-object-group");
}

// Generic modal-overlay builder (returns the overlay element).
function buildModal(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

// "Can't combine — KM names differ"
function showCantCombineModal(ms) {
  const list = ms.map(m => `<div class="combine-row"><span class="combine-name">${m.name}</span><span class="audit-badge">${MTYPE_META[m.mtype].label}</span></div>`).join("");
  const overlay = buildModal(`
    <h4><i class="fa-solid fa-triangle-exclamation" style="color:#e0a800;"></i> Can't Combine</h4>
    <div class="modal-sub">The selected measurements belong to different Key Measures.</div>
    <p class="modal-note">Combining is only allowed when every selected item shares the same KM name. Rename them to match first, or select items of the same KM.</p>
    <div class="combine-list">${list}</div>
    <div class="modal-btns"><button class="primary">OK</button></div>
  `);
  const close = () => overlay.remove();
  overlay.querySelector(".primary").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter") close(); });
  overlay.querySelector(".primary").focus();
}

// Conflict-resolution modal (names match, other attributes differ)
function showConflictModal(ms) {
  const f = ms[0];
  const sumQty = ms.reduce((s, m) => s + measureQty(m), 0);
  const unit = MTYPE_META[f.mtype].unit;
  const sumDisplay = unit === "EA" ? String(Math.round(sumQty)) : sumQty.toFixed(1);

  const sectionOpts = state.sections.map(s =>
    `<option value="${s.id}" ${s.id === f.sectionId ? "selected" : ""}>${s.name}</option>`).join("");
  const listRows = ms.map(m => `
    <div class="combine-row">
      <span class="combine-name">${m.name}</span>
      <span class="audit-badge">${unit === "EA" ? Math.round(measureQty(m)) : measureQty(m).toFixed(1)} ${unit}</span>
    </div>`).join("");

  const overlay = buildModal(`
    <h4><i class="fa-solid fa-object-group" style="color:#1a47ba;"></i> Resolve & Combine ${ms.length} Measurements</h4>
    <div class="modal-sub">"${f.name}" — same KM name, but some attributes differ. Choose the values to keep.</div>
    <div class="combine-list">${listRows}</div>

    <div class="modal-row">
      <div>
        <label>Linear Type</label>
        <select id="cf-lineartype">
          <option value="basic" ${(f.linearType||"basic")==="basic"?"selected":""}>Basic</option>
          <option value="linearPitch" ${f.linearType==="linearPitch"?"selected":""}>Linear Pitch</option>
        </select>
      </div>
      <div>
        <label>Section</label>
        <select id="cf-section">${sectionOpts}</select>
      </div>
    </div>

    <div class="modal-row">
      <div>
        <label>Combined Quantity (${unit})</label>
        <input type="number" id="cf-multiplier" value="${sumDisplay}" step="${unit==="EA"?"1":"0.1"}">
      </div>
      <div>
        <label>Use <span style="color:#9aa7b3;font-weight:400;">(optional)</span></label>
        <input type="text" id="cf-use" value="${(f.use||"").replace(/"/g,"&quot;")}" placeholder="e.g. Center carry beam">
      </div>
    </div>

    <label class="conflict-confirm"><input type="checkbox" id="cf-confirm"> I confirm the combined quantity above (${sumDisplay} ${unit}, summed from ${ms.length} items)</label>

    <label>Color</label>
    <div class="color-picks" id="cf-colors">
      ${COLOR_SWATCHES.map(c => `<span class="color-pick ${c.toLowerCase()===f.color.toLowerCase()?"selected":""}" data-color="${c}" style="background:${c}"></span>`).join("")}
    </div>

    <div class="modal-btns">
      <button class="cancel">Cancel</button>
      <button class="primary" disabled>Combine</button>
    </div>
  `);

  let color = f.color;
  const confirmBox = overlay.querySelector("#cf-confirm");
  const primaryBtn = overlay.querySelector(".primary");
  confirmBox.addEventListener("change", () => { primaryBtn.disabled = !confirmBox.checked; });
  overlay.querySelectorAll(".color-pick").forEach(sw => sw.addEventListener("click", () => {
    overlay.querySelectorAll(".color-pick").forEach(s => s.classList.remove("selected"));
    sw.classList.add("selected"); color = sw.dataset.color;
  }));
  const close = () => overlay.remove();
  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  primaryBtn.addEventListener("click", () => {
    if (!confirmBox.checked) return;
    const qv = parseFloat(overlay.querySelector("#cf-multiplier").value);
    performCombine(ms, {
      color,
      sectionId: overlay.querySelector("#cf-section").value,
      linearType: overlay.querySelector("#cf-lineartype").value,
      use: overlay.querySelector("#cf-use").value.trim(),
      qtyOverride: isNaN(qv) ? sumQty : qv
    });
    close();
  });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
}

// ====================================================================
//  TOAST
// ====================================================================
let toastTimer = null;
function showToast(msg, type = "", icon = "") {
  const c = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = (icon ? `<i class="${icon}"></i>` : "") + `<span>${msg}</span>`;
  c.innerHTML = ""; c.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2200);
}

// ====================================================================
//  ZOOM / PAN
// ====================================================================
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".ctool[data-tool]").forEach(b => b.classList.toggle("active", b.dataset.tool === tool));
  const svg = document.getElementById("draw-svg");
  svg.style.cursor = tool === "pan" ? "grab"
    : tool === "move" ? "move"
    : (tool === "select" ? (state.pasteMode ? "copy" : "default") : "crosshair");
  updateModeIndicator();
  updateStatusBar();
  renderCanvas();          // re-render so selection handles show/hide with the mode
}

// Toggle the canvas mode outline + floating badge (Move / Paste / Select).
function updateModeIndicator() {
  const wrap = document.getElementById("canvas-sheet-wrap");
  const badge = document.getElementById("mode-badge");
  const txt = document.getElementById("mode-badge-text");
  if (!wrap || !badge) return;
  wrap.classList.remove("mode-move", "mode-paste");
  badge.classList.remove("show", "move", "paste");
  if (state.pasteMode) {
    wrap.classList.add("mode-paste");
    badge.classList.add("show", "paste");
    if (txt) txt.textContent = "PASTE MODE — click to place · Esc to finish";
  } else if (state.tool === "move") {
    wrap.classList.add("mode-move");
    badge.classList.add("show", "move");
    if (txt) txt.textContent = "MOVE MODE — drag to reposition · Esc to finish";
  }
}

// Update the bottom status bar (active tool + contextual hint).
function updateStatusBar() {
  const toolEl = document.getElementById("status-tool");
  const hintEl = document.getElementById("status-hint");
  const snapEl = document.getElementById("status-snap");
  if (snapEl) snapEl.textContent = state.snap ? "Snap: On" : "Snap: Off";
  let label = "Select", hint = "Click to select · Ctrl/Shift-click to multi-select · Ctrl-drag to box-select";
  if (state.pasteMode) {
    label = "Paste"; hint = "Click on the canvas to drop a copy · Esc to finish";
  } else if (state.tool === "move") {
    label = "Move"; hint = "Drag a measurement to reposition · snaps to endpoints & grid · Esc to finish";
  } else if (state.tool === "pan") {
    label = "Pan"; hint = "Drag to pan the sheet · scroll to zoom";
  }
  if (toolEl) toolEl.textContent = label;
  if (hintEl) hintEl.textContent = hint;
}

// Enable the Combine button only when 2+ measurements are selected.
function updateToolbarState() {
  const btn = document.getElementById("btn-combine");
  if (btn) btn.disabled = state.selectedIds.size < 2;
}
function resetView() { state.view = { x: 0, y: 0, w: VIEW_W, h: VIEW_H }; }
function zoomBy(factor, cx, cy) {
  const v = state.view;
  const center = (cx != null) ? clientToSvg(cx, cy) : { x: v.x + v.w / 2, y: v.y + v.h / 2 };
  let nw = v.w / factor, nh = v.h / factor;
  nw = Math.max(VIEW_W * 0.25, Math.min(VIEW_W * 3, nw));
  nh = nw * (VIEW_H / VIEW_W);
  v.x = center.x - (center.x - v.x) * (nw / v.w);
  v.y = center.y - (center.y - v.y) * (nh / v.h);
  v.w = nw; v.h = nh;
  renderCanvas();
}

// ====================================================================
//  GLOBAL EVENTS / WIRING
// ====================================================================
function renderAll() { renderSheets(); renderCanvas(); renderTree(); updateClipboardIndicator(); updateToolbarState(); }

let spaceDown = false;
document.addEventListener("keydown", (e) => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "select" || tag === "textarea") { if (e.key === "Escape") e.target.blur(); return; }
  if (e.code === "Space") { spaceDown = true; const s = document.getElementById("draw-svg"); if (s && state.tool !== "pan") s.style.cursor = "grab"; }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelection(); }
  else if (ctrl && e.shiftKey && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard("original"); }
  else if (ctrl && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard("cursor", state.lastCanvasCursor); }
  else if (ctrl && (e.key === "a" || e.key === "A")) { e.preventDefault(); selectAll(); }
  else if (!ctrl && (e.key === "v" || e.key === "V")) { e.preventDefault(); setTool("select"); }
  else if (!ctrl && (e.key === "m" || e.key === "M")) { e.preventDefault(); setTool("move"); }
  else if (!ctrl && (e.key === "h" || e.key === "H")) { e.preventDefault(); setTool("pan"); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "Escape") {
    closeContextMenu();
    if (state.pendingPaste) {            // a collision decision is pending → cancel it
      finalizePaste("cancel");
    } else if (state.pasteMode || state.clipboard.length) {
      clearClipboard();         // clear clipboard, remove ghost, exit paste mode
      clearSelection();         // also drop any selection
      showToast("Clipboard cleared — paste mode off", "", "fa-solid fa-ban");
    } else if (state.tool !== "select") {
      setTool("select");        // commit & exit Move / Pan mode back to Select
      showToast("Back to Select mode", "", "fa-solid fa-arrow-pointer");
    } else {
      clearSelection();
    }
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") { spaceDown = false; const s = document.getElementById("draw-svg"); if (s) s.style.cursor = state.tool === "pan" ? "grab" : (state.tool === "select" ? (state.pasteMode ? "copy" : "default") : "crosshair"); }
});

// Context-menu actions
document.getElementById("ctx-copy").addEventListener("click", function () { if (!this.classList.contains("disabled")) { closeContextMenu(); copySelection(); } });
document.getElementById("ctx-paste-cursor").addEventListener("click", function () { if (!this.classList.contains("disabled")) { const pt = state.ctxPastePoint; closeContextMenu(); pasteClipboard("cursor", pt); } });
document.getElementById("ctx-paste").addEventListener("click", function () { if (!this.classList.contains("disabled")) { closeContextMenu(); pasteClipboard("original"); } });
document.getElementById("ctx-edit").addEventListener("click", function () { if (!this.classList.contains("disabled")) { const id = [...state.selectedIds][0]; closeContextMenu(); openEditModal(id); } });
document.getElementById("ctx-delete").addEventListener("click", function () { if (!this.classList.contains("disabled")) { closeContextMenu(); deleteSelection(); } });

// close context menu on outside click
document.addEventListener("click", (e) => { if (!e.target.closest("#context-menu")) closeContextMenu(); });
window.addEventListener("resize", closeContextMenu);

// Search
document.getElementById("sheet-search").addEventListener("input", (e) => { state.sheetSearch = e.target.value; renderSheets(); });
document.getElementById("tree-search").addEventListener("input", (e) => { state.treeSearch = e.target.value; renderTree(); });

// Sheets collapse
document.getElementById("sheets-collapse").addEventListener("click", () => document.getElementById("sheets-panel").classList.toggle("collapsed"));

// Tabs
document.getElementById("tab-takeoff").addEventListener("click", () => {
  document.getElementById("tab-takeoff").classList.add("active");
  document.getElementById("tab-sections").classList.remove("active");
  renderTree();
});
document.getElementById("tab-sections").addEventListener("click", () => {
  document.getElementById("tab-sections").classList.add("active");
  document.getElementById("tab-takeoff").classList.remove("active");
  document.getElementById("takeoff-tree").innerHTML = '<div style="padding:24px;color:#9aa7b3;text-align:center;font-size:12px;">Sections view — not part of this prototype.<br>Switch back to <b>Takeoff</b>.</div>';
});

// Canvas toolbar tools
document.querySelectorAll(".ctool[data-tool]").forEach(btn => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
// Combine Same KM
document.getElementById("btn-combine").addEventListener("click", function () { if (!this.disabled) combineSameKM(); });
// Collision popover buttons
document.getElementById("collide-merge").addEventListener("click", () => finalizePaste("merge"));
document.getElementById("collide-separate").addEventListener("click", () => finalizePaste("separate"));
document.getElementById("collide-cancel").addEventListener("click", () => finalizePaste("cancel"));
document.getElementById("zoom-in").addEventListener("click", () => zoomBy(1.25));
document.getElementById("zoom-out").addEventListener("click", () => zoomBy(1 / 1.25));
document.getElementById("zoom-fit").addEventListener("click", () => { resetView(); renderCanvas(); });

// SVG pointer + wheel events
function wireCanvas() {
  const svg = document.getElementById("draw-svg");
  svg.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  svg.addEventListener("contextmenu", onCanvasContextMenu);
  svg.addEventListener("dblclick", onCanvasDblClick);
  // track cursor over canvas + show paste ghost preview
  svg.addEventListener("pointermove", onCanvasHover);
  svg.addEventListener("pointerleave", removePasteGhost);
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
}

// ====================================================================
//  PASTE GHOST PREVIEW (follows cursor while clipboard has items)
// ====================================================================
function onCanvasHover(e) {
  state.lastCanvasCursor = clientToSvg(e.clientX, e.clientY);
  if (drag) { removePasteGhost(); return; }      // not while dragging
  if (state.pasteMode && state.clipboard.length) updatePasteGhost(state.lastCanvasCursor);
  else removePasteGhost();
}
function ghostShape(geom, mtype, color) {
  if (isLineGeom(mtype))
    return `<line class="ghost-line" stroke="${color}" x1="${geom.x1}" y1="${geom.y1}" x2="${geom.x2}" y2="${geom.y2}"/>`;
  if (mtype === "area")
    return `<polygon class="ghost-poly" points="${geom.points.map(p => `${p.x},${p.y}`).join(" ")}" fill="${color}" stroke="${color}"/>`;
  return `<circle class="ghost-point" cx="${geom.x}" cy="${geom.y}" r="12" fill="${color}"/>`;
}
function updatePasteGhost(pt) {
  const svg = document.getElementById("draw-svg");
  if (!svg) return;
  let g = document.getElementById("paste-ghost");
  if (!g) {
    g = document.createElementNS(SVG_NS, "g");
    g.id = "paste-ghost";
    g.setAttribute("class", "paste-ghost");
    g.setAttribute("pointer-events", "none");
    svg.appendChild(g);
  }
  let target = pt;
  let snapInfo = null;
  if (state.snap) { const sn = snapValue(pt, null); if (sn) { target = sn; snapInfo = sn; } }
  const gc = clipboardGroupCenter(state.clipboard);
  const dx = target.x - gc.x, dy = target.y - gc.y;
  let inner = "";
  state.clipboard.forEach(clip => {
    const geom = offsetGeom(JSON.parse(JSON.stringify(clip.geom)), clip.mtype, dx, dy);
    inner += ghostShape(geom, clip.mtype, clip.color);
  });
  // crosshair marker at the (snapped) paste anchor
  inner += `<line class="ghost-cross" x1="${target.x - 9}" y1="${target.y}" x2="${target.x + 9}" y2="${target.y}"/>
            <line class="ghost-cross" x1="${target.x}" y1="${target.y - 9}" x2="${target.x}" y2="${target.y + 9}"/>`;
  if (snapInfo) inner += `<circle class="snap-marker pulse" cx="${target.x}" cy="${target.y}" r="7"/>`;
  // "Click to paste" hint next to the cursor
  const hintTxt = snapInfo ? (snapInfo.kind === "endpoint" ? "Snap to endpoint · click to paste" : "Snap to grid · click to paste") : "Click to paste · Esc to cancel";
  inner += `<text class="ghost-hint" x="${target.x + 14}" y="${target.y - 12}">${hintTxt}</text>`;
  g.innerHTML = inner;
}
function removePasteGhost() {
  const g = document.getElementById("paste-ghost");
  if (g) g.remove();
}

// ===== Init =====
wireCanvas();
setTool("select");
renderAll();
