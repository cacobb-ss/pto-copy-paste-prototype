/* ====================================================================
   PTO Copy/Paste Prototype — Application Logic (vanilla JS)
   --------------------------------------------------------------------
   Architecture (mirrors the key-measure prototype):
     • Single source of truth in module-level `state`.
     • Full re-render of the takeoff tree on any state change.
     • Event delegation / per-row listeners rebuilt each render.

   Features:
     1. Multi-select (click / Ctrl+click toggle / Shift+click range)
     2. Right-click context menu (Copy / Paste / Delete) positioned at cursor
     3. Clipboard in memory + top-bar visual indicator
     4. Keyboard shortcuts: Ctrl+C, Ctrl+V, Delete, Escape
     5. Sheet navigation — active sheet drives visible items & paste target
     6. Double-click to edit item properties (modal)
     7. Toast notifications for every operation
   ==================================================================== */

// ===== State (single source of truth) =====
const state = {
  sheets: JSON.parse(JSON.stringify(SHEETS)),
  sections: JSON.parse(JSON.stringify(SECTIONS)),
  items: JSON.parse(JSON.stringify(ITEMS)),
  activeSheetId: SHEETS[1].id,      // start on Sheet_1.2 (First Floor) — has several items
  selectedIds: new Set(),           // currently selected item ids (on active sheet)
  lastSelectedId: null,             // anchor for shift-range selection
  clipboard: [],                    // array of item objects (deep copies, no id/sheetId)
  sheetSearch: "",
  treeSearch: ""
};

let idCounter = 1000;
function nextId() { return "itm-" + (++idCounter); }

// ===== Derived getters =====
function activeItems() {
  return state.items.filter(it => it.sheetId === state.activeSheetId);
}
function itemsInSection(sectionId) {
  return activeItems().filter(it => it.sectionId === sectionId);
}
function getItem(id) { return state.items.find(it => it.id === id); }
function sheetItemCount(sheetId) { return state.items.filter(it => it.sheetId === sheetId).length; }

/* Flat ordered list of currently-visible item ids on the active sheet,
   in the exact order they are rendered. Used for Shift+range selection. */
function visibleOrderedIds() {
  const ids = [];
  const tq = state.treeSearch.toLowerCase();
  state.sections.forEach(sec => {
    if (!sec.expanded) return;
    itemsInSection(sec.id).forEach(it => {
      if (tq && !it.name.toLowerCase().includes(tq) && !sec.name.toLowerCase().includes(tq)) return;
      ids.push(it.id);
    });
  });
  return ids;
}

// ====================================================================
//  RENDER — Sheets sidebar
// ====================================================================
function renderSheets() {
  const list = document.getElementById("sheet-list");
  list.innerHTML = "";
  const q = state.sheetSearch.toLowerCase();

  state.sheets
    .filter(s => !q || s.name.toLowerCase().includes(q) || (s.label || "").toLowerCase().includes(q))
    .forEach(sheet => {
      const li = document.createElement("li");
      if (sheet.id === state.activeSheetId) li.classList.add("active-sheet");
      const count = sheetItemCount(sheet.id);
      li.innerHTML = `
        <i class="fa-regular fa-file sheet-icon"></i>
        <span class="sheet-label">${sheet.name}</span>
        ${count > 0 ? `<span class="sheet-count">${count}</span>` : `<span class="sheet-meta">${sheet.label || ""}</span>`}
      `;
      li.title = sheet.label ? `${sheet.name} — ${sheet.label}` : sheet.name;
      li.addEventListener("click", () => switchSheet(sheet.id));
      list.appendChild(li);
    });
}

function switchSheet(sheetId) {
  if (sheetId === state.activeSheetId) return;
  state.activeSheetId = sheetId;
  state.selectedIds.clear();
  state.lastSelectedId = null;
  closeContextMenu();
  renderAll();
  const sheet = state.sheets.find(s => s.id === sheetId);
  showToast(`Switched to ${sheet.name}`, "info", "fa-solid fa-file");
}

// ====================================================================
//  RENDER — Canvas (placeholder reflecting active sheet)
// ====================================================================
function renderCanvas() {
  const sheet = state.sheets.find(s => s.id === state.activeSheetId);
  const corner = document.getElementById("canvas-corner");
  const title = document.getElementById("canvas-title");
  if (corner) corner.textContent = sheet ? sheet.name : "";
  if (title) {
    title.innerHTML = `<b>${(sheet && sheet.label ? sheet.label : "DRAWING").toUpperCase()}</b><small>SCALE: 1/8\" = 1'-0"</small>`;
  }
}

// ====================================================================
//  RENDER — Takeoff tree (sections + items)
// ====================================================================
function renderTree() {
  const tree = document.getElementById("takeoff-tree");
  tree.innerHTML = "";
  const q = state.treeSearch.toLowerCase();

  state.sections.forEach(sec => {
    const allItems = itemsInSection(sec.id);
    const items = q
      ? allItems.filter(it => it.name.toLowerCase().includes(q) || sec.name.toLowerCase().includes(q))
      : allItems;

    // While searching, hide sections that have no matching items and whose name doesn't match
    if (q && items.length === 0 && !sec.name.toLowerCase().includes(q)) return;

    const secEl = document.createElement("div");
    secEl.className = "section";

    // ---- Section header ----
    const header = document.createElement("div");
    header.className = "section-header";
    const expanded = q ? true : sec.expanded; // auto-expand while searching
    header.innerHTML = `
      <span class="caret ${expanded ? "open" : ""}"><i class="fa-solid fa-caret-right"></i></span>
      <i class="fa-regular fa-folder folder-icon"></i>
      <span class="section-name">${sec.name}</span>
      ${allItems.length ? `<span class="section-count">${allItems.length}</span>` : ""}
    `;
    header.addEventListener("click", () => {
      if (q) return; // don't toggle while filtering
      sec.expanded = !sec.expanded;
      renderTree();
    });
    secEl.appendChild(header);

    // ---- Items container ----
    const itemsEl = document.createElement("div");
    itemsEl.className = "section-items" + (expanded ? "" : " collapsed");

    if (expanded) {
      if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "section-empty";
        empty.textContent = "No items on this sheet";
        itemsEl.appendChild(empty);
      } else {
        items.forEach(it => itemsEl.appendChild(buildItemRow(it)));
      }
    }
    secEl.appendChild(itemsEl);
    tree.appendChild(secEl);
  });
}

function buildItemRow(it) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.dataset.itemId = it.id;
  if (state.selectedIds.has(it.id)) row.classList.add("selected");
  if (isInClipboard(it)) row.classList.add("copied");

  const icon = TYPE_ICONS[it.type] || "fa-solid fa-circle";
  row.innerHTML = `
    <i class="${icon} item-icon" title="${TYPE_LABELS[it.type] || ""}"></i>
    <span class="item-name" title="${it.name}">${it.name}</span>
    <span class="item-qty">${it.measurement}</span>
    <span class="item-color" style="background:${it.color}"></span>
  `;

  // Selection (click / ctrl / shift)
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    handleItemClick(it.id, e);
  });
  // Double-click → edit
  row.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    openEditModal(it.id);
  });
  // Right-click → context menu
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // If right-clicking an unselected item, select just that one first
    if (!state.selectedIds.has(it.id)) {
      state.selectedIds.clear();
      state.selectedIds.add(it.id);
      state.lastSelectedId = it.id;
      renderTree();
    }
    openContextMenu(e.clientX, e.clientY);
  });

  return row;
}

// ====================================================================
//  SELECTION
// ====================================================================
function handleItemClick(id, e) {
  if (e.shiftKey && state.lastSelectedId) {
    // Range selection across visible ordered ids
    const ordered = visibleOrderedIds();
    const a = ordered.indexOf(state.lastSelectedId);
    const b = ordered.indexOf(id);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(e.ctrlKey || e.metaKey)) state.selectedIds.clear();
      for (let i = lo; i <= hi; i++) state.selectedIds.add(ordered[i]);
    } else {
      state.selectedIds.add(id);
    }
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle
    if (state.selectedIds.has(id)) state.selectedIds.delete(id);
    else state.selectedIds.add(id);
    state.lastSelectedId = id;
  } else {
    // Single select
    state.selectedIds.clear();
    state.selectedIds.add(id);
    state.lastSelectedId = id;
  }
  closeContextMenu();
  renderTree();
}

function clearSelection() {
  if (state.selectedIds.size === 0) return;
  state.selectedIds.clear();
  state.lastSelectedId = null;
  renderTree();
}

// ====================================================================
//  CLIPBOARD
// ====================================================================
function isInClipboard(item) {
  // Mark the source rows that were copied (match by origin id stored on clip)
  return state.clipboard.some(c => c._sourceId === item.id && c._sourceSheetId === item.sheetId);
}

function copySelection() {
  if (state.selectedIds.size === 0) {
    showToast("Nothing selected to copy", "error", "fa-solid fa-triangle-exclamation");
    return;
  }
  // Preserve render order
  const ordered = visibleOrderedIds().filter(id => state.selectedIds.has(id));
  const ids = ordered.length ? ordered : [...state.selectedIds];
  state.clipboard = ids.map(id => {
    const it = getItem(id);
    return {
      _sourceId: it.id,
      _sourceSheetId: it.sheetId,
      name: it.name,
      type: it.type,
      quantity: it.quantity,
      unit: it.unit,
      color: it.color,
      measurement: it.measurement,
      sectionId: it.sectionId
    };
  });
  updateClipboardIndicator();
  renderTree();
  showToast(`${state.clipboard.length} item${state.clipboard.length > 1 ? "s" : ""} copied`, "success", "fa-solid fa-copy");
}

function pasteClipboard() {
  if (state.clipboard.length === 0) {
    showToast("Clipboard is empty", "error", "fa-solid fa-triangle-exclamation");
    return;
  }
  const newIds = [];
  state.clipboard.forEach(clip => {
    // Ensure the target section still exists; fallback to first section
    const sectionId = state.sections.some(s => s.id === clip.sectionId)
      ? clip.sectionId : state.sections[0].id;
    const sameSheet = clip._sourceSheetId === state.activeSheetId;
    const newItem = {
      id: nextId(),
      sheetId: state.activeSheetId,
      sectionId,
      name: sameSheet ? clip.name + " (copy)" : clip.name,
      type: clip.type,
      quantity: clip.quantity,
      unit: clip.unit,
      color: clip.color,
      measurement: clip.measurement
    };
    state.items.push(newItem);
    newIds.push(newItem.id);
    // Make sure the destination section is expanded so the paste is visible
    const sec = state.sections.find(s => s.id === sectionId);
    if (sec) sec.expanded = true;
  });

  // Select the newly pasted items
  state.selectedIds = new Set(newIds);
  state.lastSelectedId = newIds[newIds.length - 1];

  renderAll();
  // Flash animation on pasted rows
  newIds.forEach(id => {
    const el = document.querySelector(`.item-row[data-item-id="${id}"]`);
    if (el) el.classList.add("just-pasted");
  });

  const sheet = state.sheets.find(s => s.id === state.activeSheetId);
  showToast(`${newIds.length} item${newIds.length > 1 ? "s" : ""} pasted to ${sheet.name}`, "success", "fa-solid fa-paste");
}

function deleteSelection() {
  if (state.selectedIds.size === 0) {
    showToast("Nothing selected to delete", "error", "fa-solid fa-triangle-exclamation");
    return;
  }
  const count = state.selectedIds.size;
  state.items = state.items.filter(it => !state.selectedIds.has(it.id));
  // Remove any deleted source refs from clipboard markers (keep clip data)
  state.selectedIds.clear();
  state.lastSelectedId = null;
  closeContextMenu();
  renderAll();
  showToast(`${count} item${count > 1 ? "s" : ""} deleted`, "success", "fa-solid fa-trash");
}

function updateClipboardIndicator() {
  const ind = document.getElementById("clipboard-indicator");
  const countEl = document.getElementById("clip-count");
  if (state.clipboard.length > 0) {
    ind.classList.add("active");
    countEl.textContent = state.clipboard.length;
  } else {
    ind.classList.remove("active");
  }
}

// ====================================================================
//  CONTEXT MENU
// ====================================================================
function openContextMenu(x, y) {
  const menu = document.getElementById("context-menu");
  const hasSelection = state.selectedIds.size > 0;
  const hasClipboard = state.clipboard.length > 0;

  setCtxState("ctx-copy", hasSelection);
  setCtxState("ctx-paste", hasClipboard);
  setCtxState("ctx-delete", hasSelection);

  // Update copy/delete labels with count
  const n = state.selectedIds.size;
  document.querySelector("#ctx-copy .ctx-label").textContent = n > 1 ? `Copy ${n} items` : "Copy";
  document.querySelector("#ctx-delete .ctx-label").textContent = n > 1 ? `Delete ${n} items` : "Delete";
  document.querySelector("#ctx-paste .ctx-label").textContent =
    hasClipboard ? `Paste ${state.clipboard.length} item${state.clipboard.length > 1 ? "s" : ""}` : "Paste";

  menu.classList.add("open");
  // Position, keeping menu inside viewport
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = px + "px";
  menu.style.top = py + "px";
}

function setCtxState(id, enabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("disabled", !enabled);
}

function closeContextMenu() {
  document.getElementById("context-menu").classList.remove("open");
}

// ====================================================================
//  EDIT MODAL
// ====================================================================
function openEditModal(id) {
  const it = getItem(id);
  if (!it) return;
  closeContextMenu();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const units = UNIT_OPTIONS[it.type] || [it.unit];
  overlay.innerHTML = `
    <div class="modal-box">
      <h4>Edit Takeoff Item</h4>
      <div class="modal-sub">${TYPE_LABELS[it.type]} measure &middot; ${it.measurement}</div>

      <label>Name</label>
      <input type="text" id="edit-name" value="${it.name.replace(/"/g, "&quot;")}" autofocus>

      <div class="modal-row">
        <div>
          <label>Quantity</label>
          <input type="number" id="edit-qty" value="${it.quantity}" min="0" step="any">
        </div>
        <div>
          <label>Unit</label>
          <select id="edit-unit">
            ${units.map(u => `<option value="${u}" ${u === it.unit ? "selected" : ""}>${u}</option>`).join("")}
          </select>
        </div>
      </div>

      <label>Measurement (display)</label>
      <input type="text" id="edit-measure" value="${it.measurement.replace(/"/g, "&quot;")}">

      <label>Color</label>
      <div class="color-picks" id="edit-colors">
        ${COLOR_SWATCHES.map(c => `<span class="color-pick ${c.toLowerCase() === it.color.toLowerCase() ? "selected" : ""}" data-color="${c}" style="background:${c}"></span>`).join("")}
      </div>

      <div class="modal-btns">
        <button class="cancel">Cancel</button>
        <button class="primary">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  let selectedColor = it.color;
  const nameInput = overlay.querySelector("#edit-name");
  nameInput.focus();
  nameInput.select();

  overlay.querySelectorAll(".color-pick").forEach(sw => {
    sw.addEventListener("click", () => {
      overlay.querySelectorAll(".color-pick").forEach(s => s.classList.remove("selected"));
      sw.classList.add("selected");
      selectedColor = sw.dataset.color;
    });
  });

  const close = () => overlay.remove();
  const save = () => {
    const name = overlay.querySelector("#edit-name").value.trim();
    if (!name) { nameInput.style.borderColor = "#ba2121"; nameInput.focus(); return; }
    const qty = parseFloat(overlay.querySelector("#edit-qty").value) || 0;
    const unit = overlay.querySelector("#edit-unit").value;
    let measure = overlay.querySelector("#edit-measure").value.trim();
    if (!measure) measure = `${qty} ${unit}`;

    it.name = name;
    it.quantity = qty;
    it.unit = unit;
    it.measurement = measure;
    it.color = selectedColor;

    close();
    renderAll();
    showToast(`Updated "${name}"`, "success", "fa-solid fa-pen");
  };

  overlay.querySelector(".cancel").addEventListener("click", close);
  overlay.querySelector(".primary").addEventListener("click", save);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName !== "BUTTON") save();
    if (e.key === "Escape") close();
  });
}

// ====================================================================
//  TOAST
// ====================================================================
let toastTimer = null;
function showToast(msg, type = "", icon = "") {
  const container = document.getElementById("toast-container");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.innerHTML = (icon ? `<i class="${icon}"></i>` : "") + `<span>${msg}</span>`;
  container.innerHTML = "";
  container.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, 2400);
}

// ====================================================================
//  GLOBAL EVENTS
// ====================================================================
function renderAll() {
  renderSheets();
  renderTree();
  renderCanvas();
  updateClipboardIndicator();
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  // Ignore when typing in an input/select/textarea
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "select" || tag === "textarea";
  if (typing) {
    if (e.key === "Escape") e.target.blur();
    return;
  }

  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === "c" || e.key === "C")) { e.preventDefault(); copySelection(); }
  else if (ctrl && (e.key === "v" || e.key === "V")) { e.preventDefault(); pasteClipboard(); }
  else if (ctrl && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    visibleOrderedIds().forEach(id => state.selectedIds.add(id));
    renderTree();
  }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelection(); }
  else if (e.key === "Escape") { closeContextMenu(); clearSelection(); }
});

// Context menu item actions
document.getElementById("ctx-copy").addEventListener("click", function () {
  if (this.classList.contains("disabled")) return;
  closeContextMenu(); copySelection();
});
document.getElementById("ctx-paste").addEventListener("click", function () {
  if (this.classList.contains("disabled")) return;
  closeContextMenu(); pasteClipboard();
});
document.getElementById("ctx-delete").addEventListener("click", function () {
  if (this.classList.contains("disabled")) return;
  closeContextMenu(); deleteSelection();
});

// Close context menu on any outside click / scroll / resize
document.addEventListener("click", (e) => {
  if (!e.target.closest("#context-menu")) closeContextMenu();
});
document.addEventListener("contextmenu", (e) => {
  // Right-click on empty tree area clears selection & shows paste-only menu
  if (e.target.closest("#takeoff-tree") && !e.target.closest(".item-row")) {
    e.preventDefault();
    clearSelection();
    openContextMenu(e.clientX, e.clientY);
  } else if (!e.target.closest(".item-row")) {
    closeContextMenu();
  }
});
document.querySelector(".takeoff-tree") &&
  document.querySelector(".takeoff-tree").addEventListener("scroll", closeContextMenu);
window.addEventListener("resize", closeContextMenu);

// Search inputs
document.getElementById("sheet-search").addEventListener("input", (e) => {
  state.sheetSearch = e.target.value;
  renderSheets();
});
document.getElementById("tree-search").addEventListener("input", (e) => {
  state.treeSearch = e.target.value;
  renderTree();
});

// Collapse sheets panel toggle
document.getElementById("sheets-collapse").addEventListener("click", () => {
  document.getElementById("sheets-panel").classList.toggle("collapsed");
});

// Tabs
document.getElementById("tab-takeoff").addEventListener("click", () => {
  document.getElementById("tab-takeoff").classList.add("active");
  document.getElementById("tab-sections").classList.remove("active");
  renderTree();
});
document.getElementById("tab-sections").addEventListener("click", () => {
  document.getElementById("tab-sections").classList.add("active");
  document.getElementById("tab-takeoff").classList.remove("active");
  document.getElementById("takeoff-tree").innerHTML =
    '<div style="padding:24px;color:#9aa7b3;text-align:center;font-size:12px;">Sections view — not part of this prototype.<br>Switch back to <b>Takeoff</b>.</div>';
});

// ===== Init =====
renderAll();
