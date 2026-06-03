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
  tool: "select",                // select | pan | line | area | point
  view: { x: 0, y: 0, w: VIEW_W, h: VIEW_H },
  expandedSheets: new Set(["sheet-1-2"]),
  lastCanvasCursor: { x: VIEW_W / 2, y: VIEW_H / 2 }, // last known cursor in SVG coords
  ctxPastePoint: null,                                 // SVG point to use for "paste at cursor"
  pasteMode: false                                     // true after copy → click-to-paste active
};

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
function measureLabel(m) {
  if (m.mtype === "line")  return `${lineFeet(m.geom).toFixed(1)} LF`;
  if (m.mtype === "area")  return `${Math.round(polyFeet2(m.geom.points)).toLocaleString()} SF`;
  return `${m.geom.count || 1} EA`;
}
function measureBBox(m) {
  if (m.mtype === "line") {
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
  if (mtype === "line")  return { x1: geom.x1 + dx, y1: geom.y1 + dy, x2: geom.x2 + dx, y2: geom.y2 + dy };
  if (mtype === "area")  return { points: geom.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
  return { x: geom.x + dx, y: geom.y + dy, count: geom.count };
}
// center point of a geometry (line midpoint / polygon centroid / point itself)
function geomCenter(geom, mtype) {
  if (mtype === "line")  return { x: (geom.x1 + geom.x2) / 2, y: (geom.y1 + geom.y2) / 2 };
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

// ===== derived getters =====
const activeMeasures = () => state.measures.filter(m => m.sheetId === state.activeSheetId);
const measuresOnSheet = (sid) => state.measures.filter(m => m.sheetId === sid);
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
  // point
  const { x, y } = m.geom;
  return `<g class="meas ${sel ? "selected" : ""}" data-mid="${m.id}">
    ${cp ? `<circle class="copied-outline" cx="${x}" cy="${y}" r="15"/>` : ""}
    <circle class="meas-point-dot" cx="${x}" cy="${y}" r="12" fill="${m.color}"/>
    <text class="point-badge" x="${x}" y="${y + 4}">${m.geom.count || 1}</text>
  </g>`;
}

function selectionSvg(m) {
  let s = "";
  if (m.mtype === "line") {
    s += handle(m.geom.x1, m.geom.y1, m.id, "p1");
    s += handle(m.geom.x2, m.geom.y2, m.id, "p2");
  } else if (m.mtype === "area") {
    const bb = measureBBox(m);
    s += `<rect class="sel-outline" x="${bb.x1 - 4}" y="${bb.y1 - 4}" width="${bb.x2 - bb.x1 + 8}" height="${bb.y2 - bb.y1 + 8}"/>`;
    m.geom.points.forEach((p, i) => { s += handle(p.x, p.y, m.id, "v" + i); });
  } else {
    s += `<circle class="sel-outline" cx="${m.geom.x}" cy="${m.geom.y}" r="17"/>`;
    s += handle(m.geom.x, m.geom.y - 17, m.id, "pt", true);
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
    if (svg) svg.style.cursor = state.tool === "pan" ? "grab" : (state.tool === "select" ? "default" : "crosshair");
  }
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
    const target = pt || state.lastCanvasCursor || viewportCenter();
    const gc = clipboardGroupCenter(state.clipboard);
    groupDx = target.x - gc.x;
    groupDy = target.y - gc.y;
  }

  const newIds = [];
  state.clipboard.forEach(clip => {
    const sameSheet = clip._sourceSheetId === state.activeSheetId;
    let dx, dy;
    if (mode === "cursor") {
      dx = groupDx; dy = groupDy;
    } else {
      // original location: nudge same-sheet copies so they don't sit exactly on top
      dx = sameSheet ? 36 : 0; dy = sameSheet ? 36 : 0;
    }
    const sectionId = state.sections.some(s => s.id === clip.sectionId) ? clip.sectionId : state.sections[0].id;
    const nm = {
      id: nextId(),
      sheetId: state.activeSheetId,
      sectionId,
      name: sameSheet ? clip.name + " (copy)" : clip.name,
      mtype: clip.mtype,
      color: clip.color,
      geom: offsetGeom(JSON.parse(JSON.stringify(clip.geom)), clip.mtype, dx, dy)
    };
    state.measures.push(nm);
    newIds.push(nm.id);
    const sec = state.sections.find(s => s.id === sectionId);
    if (sec) sec.expanded = true;
  });
  state.selectedIds = new Set(newIds);
  state.lastSelectedId = newIds[newIds.length - 1];
  renderAll();
  // flash pasted
  newIds.forEach(id => {
    const g = document.querySelector(`.meas[data-mid="${id}"]`);
    if (g) g.classList.add("just-pasted");
  });
  const sheet = state.sheets.find(s => s.id === state.activeSheetId);
  const where = mode === "cursor" ? "at cursor" : "at original location";
  const icon = mode === "cursor" ? "fa-solid fa-location-crosshairs" : "fa-solid fa-paste";
  // keep the clipboard so the user can place more copies; stay in paste mode (Esc clears)
  setPasteMode(true);
  showToast(`${newIds.length} measurement${newIds.length > 1 ? "s" : ""} pasted ${where} on ${sheet.name} — keep clicking to place more, Esc to finish`, "success", icon);
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

  // RESIZE handle?
  const handleEl = e.target.closest(".handle");
  if (handleEl) {
    const mid = handleEl.dataset.mid, h = handleEl.dataset.handle;
    const m = getMeasure(mid);
    drag = { mode: "resize", mid, handle: h, start: p, snapshot: JSON.parse(JSON.stringify(m.geom)) };
    svg.setPointerCapture(e.pointerId);
    return;
  }

  // MEASUREMENT body?
  const g = e.target.closest(".meas");
  if (g) {
    const mid = g.dataset.mid;
    // selection (respect modifiers)
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      selectMeasure(mid, e);
      return; // don't start a move when modifier-selecting
    }
    if (!state.selectedIds.has(mid)) {
      state.selectedIds.clear();
      state.selectedIds.add(mid);
      state.lastSelectedId = mid;
      renderAll();
    }
    // begin move of all selected
    const snap = {};
    state.selectedIds.forEach(id => { snap[id] = JSON.parse(JSON.stringify(getMeasure(id).geom)); });
    drag = { mode: "move", start: p, snapshot: snap, moved: false };
    svg.setPointerCapture(e.pointerId);
    return;
  }

  // EMPTY canvas → rubber-band select (clear first unless additive)
  if (!(e.ctrlKey || e.metaKey || e.shiftKey)) {
    state.selectedIds.clear();
    state.lastSelectedId = null;
    renderAll();
  }
  drag = { mode: "band", start: p, additive: (e.ctrlKey || e.metaKey || e.shiftKey) };
  svg.setPointerCapture(e.pointerId);
  closeContextMenu();
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
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
    Object.keys(drag.snapshot).forEach(id => {
      const m = getMeasure(id);
      m.geom = offsetGeom(drag.snapshot[id], m.mtype, dx, dy);
    });
    renderCanvas();
    return;
  }

  if (drag.mode === "resize") {
    const m = getMeasure(drag.mid);
    if (m.mtype === "line") {
      if (drag.handle === "p1") { m.geom.x1 = p.x; m.geom.y1 = p.y; }
      else { m.geom.x2 = p.x; m.geom.y2 = p.y; }
    } else if (m.mtype === "area") {
      const i = parseInt(drag.handle.slice(1), 10);
      m.geom.points[i] = { x: p.x, y: p.y };
    } else {
      m.geom.x = p.x; m.geom.y = p.y + 17;   // 'pt' move handle sits above the dot
    }
    renderCanvas();
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
    if (drag.moved) {
      renderAll();
      const n = state.selectedIds.size;
      showToast(`Moved ${n} measurement${n > 1 ? "s" : ""}`, "info", "fa-solid fa-up-down-left-right");
    }
    drag = null;
    return;
  }

  if (drag.mode === "resize") {
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
    : (tool === "select" ? (state.pasteMode ? "copy" : "default") : "crosshair");
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
function renderAll() { renderSheets(); renderCanvas(); renderTree(); updateClipboardIndicator(); }

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
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "Escape") {
    closeContextMenu();
    if (state.pasteMode || state.clipboard.length) {
      clearClipboard();         // clear clipboard, remove ghost, exit paste mode
      clearSelection();         // also drop any selection
      showToast("Clipboard cleared — paste mode off", "", "fa-solid fa-ban");
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
  if (mtype === "line")
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
  const gc = clipboardGroupCenter(state.clipboard);
  const dx = pt.x - gc.x, dy = pt.y - gc.y;
  let inner = "";
  state.clipboard.forEach(clip => {
    const geom = offsetGeom(JSON.parse(JSON.stringify(clip.geom)), clip.mtype, dx, dy);
    inner += ghostShape(geom, clip.mtype, clip.color);
  });
  // crosshair marker at the cursor (paste anchor)
  inner += `<line class="ghost-cross" x1="${pt.x - 9}" y1="${pt.y}" x2="${pt.x + 9}" y2="${pt.y}"/>
            <line class="ghost-cross" x1="${pt.x}" y1="${pt.y - 9}" x2="${pt.x}" y2="${pt.y + 9}"/>`;
  // "Click to paste" hint next to the cursor
  inner += `<text class="ghost-hint" x="${pt.x + 14}" y="${pt.y - 12}">Click to paste · Esc to cancel</text>`;
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
