// Home Assistant Lovelace custom card wrapper.
//
// This is the ONLY file in src/ that knows it's running inside Home
// Assistant — it implements the Lovelace card contract (setConfig, the
// hass setter, getCardSize) and renders into its own shadow DOM so this
// card's styles can't leak into the rest of the dashboard, and the
// dashboard's styles can't leak into this card.
//
// Everything else (snapping, drag/overlap decisions, DOM building) is
// unchanged from the standalone prototype — this file is orchestration,
// same role src/index.html played there, just re-hosted as a custom
// element instead of a full page. See SPEC.md, "Module structure."

import { deleteRoom, tryAddRoom, tryMoveVertex, tryTranslateRoom, weldVertexOnRelease, tryResizeWall, computeZoomTransition, snapPoint, worldFromScreen, screenFromWorld, fmtLength } from './interactions.js';
import { renderCanvas as renderCanvasDom, renderRoomList as renderRoomListDom, renderFloorTabs as renderFloorTabsDom, renderInspector as renderInspectorDom } from './render.js';

const STYLE = `
  :host {
    display: block;
    height: var(--floorplan-card-height, 500px);
    --bg: #17191d;
    --panel: #1f2227;
    --panel-border: #2c3038;
    --grid-line: #262a31;
    --guide-line: #f6ad55;
    --text: #d7dade;
    --text-dim: #838993;
    --accent: #5b8def;
    --accent-dim: #395790;
    --danger: #e5534b;
    --mono: "SF Mono", "Cascadia Code", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  .card-root {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    height: 100%; display: flex; flex-direction: column; overflow: hidden;
    border-radius: var(--ha-card-border-radius, 12px);
  }

  #topbar {
    display: flex; align-items: center; gap: 16px; padding: 10px 16px;
    background: var(--panel); border-bottom: 1px solid var(--panel-border); flex-shrink: 0;
  }
  #floor-tabs { display: flex; gap: 4px; }
  .floor-tab {
    padding: 6px 12px; border-radius: 6px; background: transparent; color: var(--text-dim);
    border: 1px solid transparent; cursor: pointer; font-size: 13px;
  }
  .floor-tab.active { background: var(--accent-dim); color: var(--text); }
  .floor-tab:hover:not(.active) { border-color: var(--panel-border); }
  #add-floor {
    background: none; border: 1px dashed var(--panel-border); color: var(--text-dim);
    border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 13px;
  }
  .divider { width: 1px; height: 22px; background: var(--panel-border); }
  button.tool {
    background: var(--panel); border: 1px solid var(--panel-border); color: var(--text);
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px;
    display: flex; align-items: center; gap: 6px;
  }
  button.tool:hover { border-color: var(--accent-dim); }
  button.tool.active { background: var(--accent); border-color: var(--accent); color: #10131a; font-weight: 600; }
  label.checkbox { font-size: 13px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; }
  #hint { margin-left: auto; font-size: 12px; color: var(--text-dim); font-family: var(--mono); }
  #warn {
    font-size: 12px; color: var(--danger); font-family: var(--mono); min-width: 0;
    opacity: 0; transition: opacity 0.15s;
  }
  #warn.show { opacity: 1; }

  #body { flex: 1; display: flex; overflow: hidden; }
  #sidebar {
    width: 260px; background: var(--panel); border-right: 1px solid var(--panel-border);
    display: flex; flex-direction: column; flex-shrink: 0; overflow-y: auto;
  }
  #sidebar h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-dim);
    margin: 14px 14px 6px;
  }
  #room-list { list-style: none; margin: 0; padding: 0 8px; }
  #room-list li {
    display: flex; align-items: center; gap: 8px; padding: 8px 8px; border-radius: 6px;
    cursor: pointer; font-size: 13px; color: var(--text);
  }
  #room-list li:hover { background: #ffffff08; }
  #room-list li.selected { background: var(--accent-dim); }
  #room-list .swatch { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
  #room-list .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #room-list .empty { color: var(--text-dim); font-size: 12px; font-style: italic; padding: 4px; }

  #inspector { padding: 12px 14px; border-top: 1px solid var(--panel-border); }
  #inspector input[type=text] {
    width: 100%; background: var(--bg); border: 1px solid var(--panel-border); color: var(--text);
    padding: 6px 8px; border-radius: 5px; font-size: 13px; margin-bottom: 8px;
  }
  #inspector .row { display: flex; gap: 6px; }
  #inspector button {
    flex: 1; background: var(--bg); border: 1px solid var(--panel-border); color: var(--text);
    padding: 6px 8px; border-radius: 5px; cursor: pointer; font-size: 12px;
  }
  #inspector button.danger { color: var(--danger); border-color: #e5534b55; }
  #inspector .empty { color: var(--text-dim); font-size: 12px; font-style: italic; }
  #inspector .entity-note {
    font-size: 11px; color: var(--text-dim); margin-top: 10px; line-height: 1.5;
    border-top: 1px dashed var(--panel-border); padding-top: 8px;
  }

  #footer-actions { margin-top: auto; padding: 12px 14px; border-top: 1px solid var(--panel-border); display: flex; gap: 8px; }
  #footer-actions button {
    flex: 1; background: var(--bg); border: 1px solid var(--panel-border); color: var(--text);
    padding: 7px; border-radius: 5px; cursor: pointer; font-size: 12px;
  }

  #canvas-wrap { flex: 1; position: relative; overflow: hidden; background: var(--bg); }
  svg { width: 100%; height: 100%; display: block; cursor: crosshair; touch-action: none; }
  svg.select-mode { cursor: default; }

  #zoom-controls {
    position: absolute; right: 16px; bottom: 16px; z-index: 5;
    display: flex; flex-direction: column; align-items: stretch;
    background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px;
    overflow: hidden; box-shadow: 0 2px 10px #00000055;
  }
  #zoom-controls button {
    width: 40px; height: 40px; background: transparent; border: none; color: var(--text);
    font-size: 18px; cursor: pointer; touch-action: manipulation;
  }
  #zoom-controls button:hover { background: #ffffff10; }
  #zoom-controls button:active { background: #ffffff1a; }
  #zoom-level {
    font-size: 10px; font-family: var(--mono); color: var(--text-dim); text-align: center;
    padding: 4px 0; border-top: 1px solid var(--panel-border); border-bottom: 1px solid var(--panel-border);
    cursor: pointer; user-select: none;
  }
  #zoom-level:hover { color: var(--text); }

  .room-polygon { stroke-width: 1.5; }
  .room-polygon.selected { stroke-width: 2.5; }
  .room-polygon.invalid { stroke: var(--danger) !important; fill: #e5534b33 !important; }
  .room-label { fill: var(--text); font-size: 12px; font-family: var(--mono); pointer-events: none; user-select: none; }
  .vertex-handle { fill: var(--bg); stroke: var(--accent); stroke-width: 2; cursor: grab; }
  .vertex-handle:hover { fill: var(--accent); }
  .draft-line { stroke: var(--accent); stroke-width: 1.5; stroke-dasharray: 4 3; fill: none; }
  .draft-point { fill: var(--accent); }
  .draft-point.first { fill: none; stroke: var(--accent); stroke-width: 2; }
  .guide-line { stroke: var(--guide-line); stroke-width: 1; stroke-dasharray: 3 3; }
  .measure-hit { fill: var(--bg); stroke: var(--panel-border); stroke-width: 1; cursor: text; }
  .measure-hit:hover { stroke: var(--accent); }
  .measure-text { fill: var(--text-dim); font-size: 10px; font-family: var(--mono); pointer-events: none; text-anchor: middle; dominant-baseline: middle; }

  #length-input {
    position: absolute; z-index: 10; font-family: var(--mono); font-size: 11px;
    background: var(--bg); border: 1px solid var(--accent); color: var(--text);
    padding: 2px 4px; border-radius: 3px; width: 60px; text-align: center;
  }

  #hamburger {
    display: none;
    background: var(--panel); border: 1px solid var(--panel-border); color: var(--text);
    width: 34px; height: 34px; border-radius: 6px; cursor: pointer; font-size: 16px;
    align-items: center; justify-content: center; flex-shrink: 0;
  }
  #sidebar-backdrop { display: none; }

  /* ---------- Mobile layout ---------- */
  @media (max-width: 760px) {
    #hamburger { display: flex; }
    #hint { display: none; }
    #topbar { padding: 8px 10px; gap: 10px; flex-wrap: wrap; row-gap: 8px; }
    #floor-tabs { overflow-x: auto; max-width: 55vw; scrollbar-width: none; }
    #floor-tabs::-webkit-scrollbar { display: none; }
    .floor-tab { flex-shrink: 0; }
    button.tool { padding: 8px 12px; touch-action: manipulation; }
    #add-floor { touch-action: manipulation; }

    #sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; z-index: 30;
      width: 82vw; max-width: 320px;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      box-shadow: 2px 0 16px #00000066;
    }
    #sidebar.open { transform: translateX(0); }
    #sidebar-backdrop.open {
      display: block; position: fixed; inset: 0; background: #00000066; z-index: 20;
    }
    #room-list li { padding: 12px 8px; }
    #inspector button, #footer-actions button { padding: 11px 8px; }
    .vertex-handle { r: 10; }
  }
`;

const TEMPLATE = `
  <div id="sidebar-backdrop"></div>

  <div id="topbar">
    <button id="hamburger">☰</button>
    <div id="floor-tabs"></div>
    <button id="add-floor">+ Floor</button>
    <div class="divider"></div>
    <button class="tool" id="btn-draw">✏️ Draw Room</button>
    <button class="tool active" id="btn-select">↖ Select</button>
    <div class="divider"></div>
    <label class="checkbox"><input type="checkbox" id="snap-toggle" checked> Snap to grid</label>
    <label class="checkbox"><input type="checkbox" id="measure-toggle" checked> Show measurements</label>
    <div id="warn">⚠ would overlap another room</div>
    <div id="hint">Click to place points · double-click or click first point to close</div>
  </div>

  <div id="body">
    <div id="sidebar">
      <h3>Rooms</h3>
      <ul id="room-list"></ul>
      <div id="inspector"></div>
      <div id="footer-actions">
        <button id="btn-export">Export JSON</button>
        <button id="btn-import">Import JSON</button>
      </div>
    </div>
    <div id="canvas-wrap">
      <svg id="canvas"></svg>
      <div id="zoom-controls">
        <button id="zoom-in" title="Zoom in">+</button>
        <div id="zoom-level" title="Reset to 100%">100%</div>
        <button id="zoom-out" title="Zoom out">−</button>
      </div>
    </div>
  </div>

  <input type="file" id="file-input" accept="application/json" style="display:none">

`;

const GRID = 25;
const PX_PER_METER = 50;
const CLOSE_THRESHOLD = 12;
const SNAP_WELD_DIST = 12;
const SNAP_AXIS_DIST = 7;
const COLORS = ["#5b8def", "#4fd1c5", "#f6ad55", "#f687b3", "#9f7aea", "#68d391"];
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2];

class FloorplanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><div class="card-root">${TEMPLATE}</div>`;

    // ---------- State ----------
    // Same shapes as the standalone prototype — see SPEC.md, "Data model".
    this._state = {
      floors: [{ id: "floor-1", name: "Ground Floor", vertices: {}, rooms: [] }],
      currentFloorId: "floor-1",
      selectedRoomId: null,
    };
    this._zoomIndex = 2;
    this._view = { panX: 0, panY: 0, zoom: ZOOM_LEVELS[this._zoomIndex] };
    this._isPanKeyHeld = false;
    this._mode = "select";
    this._drawingPoints = [];
    this._dragging = null;
    this._mousePos = { x: 0, y: 0 };
    this._guides = [];
    this._invalidRoomIds = new Set();
    // Global keydown/keyup shortcuts (Escape, Enter, Backspace, the m-key
    // pan override) would otherwise fire no matter where focus is on the
    // whole HA dashboard, potentially stealing keystrokes meant for a
    // search box or another card. Gate them on the pointer actually being
    // over this card's canvas.
    this._pointerOverCanvas = false;

    this._$ = (sel) => this.shadowRoot.querySelector(sel);
    this._svg = this._$("#canvas");
    this._roomListEl = this._$("#room-list");
    this._inspectorEl = this._$("#inspector");
    this._floorTabsEl = this._$("#floor-tabs");
    this._warnEl = this._$("#warn");

    this._bindDom();
    this._render();
  }

  // ---------- Lovelace card contract ----------
  setConfig(config) {
    this._config = config || {};
    if (config && config.floors) {
      // A floor plan saved into the dashboard's own YAML/storage config.
      // See SPEC.md, "Persistence", for why this is the default and when
      // you'd want the backend-integration approach instead.
      this._state.floors = config.floors;
      this._state.currentFloorId = config.floors[0] ? config.floors[0].id : "floor-1";
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Entity binding / live state overlay lands here in a later step —
    // intentionally not implemented yet (see SPEC.md).
  }

  getCardSize() {
    return 6;
  }

  static getStubConfig() {
    return { floors: [{ id: "floor-1", name: "Ground Floor", vertices: {}, rooms: [] }] };
  }

  // Persist edits back to the dashboard's stored config (Lovelace listens
  // for this event on any card and writes the returned config into the
  // dashboard's YAML/storage) — the counterpart to reading config.floors
  // in setConfig above.
  _persist() {
    this._config = { ...this._config, floors: this._state.floors };
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
  }

  // ---------- Rendering orchestration ----------
  _render() {
    this._renderTopbar();
    renderFloorTabsDom(this._floorTabsEl, this._state.floors, this._state.currentFloorId, { onSelectFloor: (id) => this._selectFloor(id) });
    this._renderCanvas();
    renderRoomListDom(this._roomListEl, this._currentFloor(), this._state.selectedRoomId, { onSelectRoom: (id) => this._selectRoom(id) });
    renderInspectorDom(this._inspectorEl, this._selectedRoom(), {
      onRename: (name) => this._renameSelectedRoom(name),
      onDelete: () => this._deleteSelectedRoom(),
    });
  }
  _renderTopbar() {
    this._$("#btn-draw").classList.toggle("active", this._mode === "draw");
    this._$("#btn-select").classList.toggle("active", this._mode === "select");
    this._svg.classList.toggle("select-mode", this._mode === "select");
  }
  _renderCanvas() {
    const appState = {
      floor: this._currentFloor(),
      selectedRoomId: this._state.selectedRoomId,
      invalidRoomIds: this._invalidRoomIds, guides: this._guides, mode: this._mode,
      drawingPoints: this._drawingPoints, mousePos: this._mousePos, view: this._view,
      showMeasurements: this._$("#measure-toggle").checked,
    };
    renderCanvasDom(this._svg, appState, GRID, (px) => fmtLength(px, PX_PER_METER), {
      onRoomPointerDown: (e, room) => this._onRoomPointerDown(e, room),
      onVertexPointerDown: (e, vid) => this._onVertexPointerDown(e, vid),
      onMeasurementEdit: (edge, lx, ly, len) => this._startLengthEdit(edge, lx, ly, len),
    });
  }

  _currentFloor() { return this._state.floors.find((f) => f.id === this._state.currentFloorId); }
  _selectedRoom() {
    const f = this._currentFloor();
    return f ? f.rooms.find((r) => r.id === this._state.selectedRoomId) : null;
  }
  _snapGridValue(v) {
    return this._$("#snap-toggle").checked ? Math.round(v / GRID) * GRID : Math.round(v);
  }
  _screenPoint(evt) {
    const rect = this._svg.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }
  _snapCurrent(rawX, rawY, excludeVid) {
    const result = snapPoint(this._currentFloor(), this._view, rawX, rawY, excludeVid, {
      snapToGrid: this._$("#snap-toggle").checked,
      grid: GRID, weldDist: SNAP_WELD_DIST, axisDist: SNAP_AXIS_DIST,
    });
    this._guides = result.guides;
    return result;
  }

  // ---------- Selection / floor / room list callbacks ----------
  _selectFloor(floorId) {
    this._state.currentFloorId = floorId;
    this._state.selectedRoomId = null;
    this._cancelDraw();
    this._render();
  }
  _selectRoom(roomId) {
    this._state.selectedRoomId = roomId;
    this._mode = "select";
    this._render();
    this._closeDrawer();
  }
  _renameSelectedRoom(newName) {
    const room = this._selectedRoom();
    if (!room) return;
    room.name = newName;
    renderRoomListDom(this._roomListEl, this._currentFloor(), this._state.selectedRoomId, { onSelectRoom: (id) => this._selectRoom(id) });
    this._renderCanvas();
    this._persist();
  }
  _deleteSelectedRoom() {
    const room = this._selectedRoom();
    if (!room) return;
    deleteRoom(this._currentFloor(), room.id);
    this._state.selectedRoomId = null;
    this._render();
    this._persist();
  }

  // ---------- Zoom ----------
  _canvasCenter() {
    const rect = this._svg.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }
  _updateZoomLabel() {
    const labelEl = this._$("#zoom-level");
    if (labelEl) labelEl.textContent = Math.round(this._view.zoom * 100) + "%";
  }
  _applyZoom(newIndex, screenCenter) {
    const transition = computeZoomTransition(ZOOM_LEVELS, this._zoomIndex, newIndex, this._view, screenCenter);
    if (!transition) return;
    this._zoomIndex = transition.index;
    this._view = transition.view;
    this._renderCanvas();
    this._updateZoomLabel();
  }

  // ---------- Panning ----------
  _beginPanDrag(screen) {
    this._dragging = { type: "pan", startScreenX: screen.x, startScreenY: screen.y, startPanX: this._view.panX, startPanY: this._view.panY };
    this._svg.style.cursor = "grabbing";
  }

  // ---------- Draw mode ----------
  _cancelDraw() { this._drawingPoints = []; this._guides = []; }
  _flashWarn() {
    this._warnEl.classList.add("show");
    setTimeout(() => this._warnEl.classList.remove("show"), 1400);
  }
  _finishRoom() {
    const floor = this._currentFloor();
    const result = tryAddRoom(floor, this._drawingPoints, COLORS, floor.rooms.length, "Room " + (floor.rooms.length + 1));
    if (!result.ok) {
      if (result.reason === "overlap") this._flashWarn();
      this._cancelDraw();
      this._mode = "select";
      this._render();
      return;
    }
    this._state.selectedRoomId = result.room.id;
    this._cancelDraw();
    this._mode = "select";
    this._render();
    this._persist();
  }

  // ---------- Vertex / room dragging ----------
  _onVertexPointerDown(e, vid) {
    e.stopPropagation();
    if (this._isPanKeyHeld) { this._beginPanDrag(this._screenPoint(e)); return; }
    this._dragging = { type: "vertex", vid };
  }
  _onRoomPointerDown(e, room) {
    if (this._isPanKeyHeld) { e.stopPropagation(); this._beginPanDrag(this._screenPoint(e)); return; }
    if (this._mode !== "select") return;
    e.stopPropagation();
    this._state.selectedRoomId = room.id;
    const p = worldFromScreen(this._view, this._screenPoint(e).x, this._screenPoint(e).y);
    const floor = this._currentFloor();
    const snapshot = {};
    room.vertexIds.forEach((vid) => { snapshot[vid] = { ...floor.vertices[vid] }; });
    this._dragging = { type: "room", roomId: room.id, startX: p.x, startY: p.y, snapshot };
    this._render();
  }

  // ---------- DOM event wiring ----------
  _bindDom() {
    this._svg.addEventListener("pointerenter", () => { this._pointerOverCanvas = true; });
    this._svg.addEventListener("pointerleave", () => { this._pointerOverCanvas = false; });

    this._svg.addEventListener("pointerdown", (e) => {
      const screen = this._screenPoint(e);
      if (this._isPanKeyHeld) { this._beginPanDrag(screen); return; }
      if (this._mode === "select") {
        // Reached the raw canvas (not a room/vertex, which stopPropagation
        // before this fires) while in select mode — treat as empty space.
        this._beginPanDrag(screen);
        return;
      }
      if (this._mode !== "draw") return;
      const p = worldFromScreen(this._view, screen.x, screen.y);
      if (this._drawingPoints.length >= 3) {
        const first = this._drawingPoints[0];
        const firstScreen = screenFromWorld(this._view, first.x, first.y);
        if (Math.hypot(firstScreen.x - screen.x, firstScreen.y - screen.y) <= CLOSE_THRESHOLD) { this._finishRoom(); return; }
      }
      const snapped = this._snapCurrent(p.x, p.y, null);
      this._drawingPoints.push(snapped);
      this._mousePos = { x: snapped.x, y: snapped.y };
      this._renderCanvas();
    });
    this._svg.addEventListener("dblclick", (e) => { if (this._mode === "draw") { e.preventDefault(); this._finishRoom(); } });

    this._svg.addEventListener("pointermove", (e) => {
      const screen = this._screenPoint(e);

      if (this._dragging && this._dragging.type === "pan") {
        this._view.panX = this._dragging.startPanX + (screen.x - this._dragging.startScreenX);
        this._view.panY = this._dragging.startPanY + (screen.y - this._dragging.startScreenY);
        this._renderCanvas();
        return;
      }

      const p = worldFromScreen(this._view, screen.x, screen.y);
      this._mousePos = p;

      if (this._dragging && this._dragging.type === "vertex") {
        const floor = this._currentFloor();
        const snapped = this._snapCurrent(p.x, p.y, this._dragging.vid);
        tryMoveVertex(floor, this._dragging.vid, { x: snapped.x, y: snapped.y });
        this._renderCanvas();
        return;
      }
      if (this._dragging && this._dragging.type === "room") {
        const floor = this._currentFloor();
        const room = floor.rooms.find((r) => r.id === this._dragging.roomId);
        const dx = this._snapGridValue(p.x - this._dragging.startX), dy = this._snapGridValue(p.y - this._dragging.startY);
        tryTranslateRoom(floor, room, this._dragging.snapshot, dx, dy);
        this._renderCanvas();
        return;
      }
      if (this._mode === "draw" && this._drawingPoints.length > 0) {
        const snapped = this._snapCurrent(p.x, p.y, null);
        this._mousePos = { x: snapped.x, y: snapped.y };
        this._renderCanvas();
      }
    });

    window.addEventListener("pointerup", () => {
      if (!this._dragging) return;
      const wasGeometryDrag = this._dragging.type === "vertex" || this._dragging.type === "room";

      if (this._dragging.type === "pan") {
        this._svg.style.cursor = this._isPanKeyHeld ? "grab" : "";
        this._dragging = null;
        return;
      }
      if (this._dragging.type === "vertex") {
        weldVertexOnRelease(this._currentFloor(), this._dragging.vid);
      }
      this._dragging = null;
      this._guides = [];
      this._render();
      if (wasGeometryDrag) this._persist();
    });

    this._$("#btn-draw").onclick = () => { this._mode = "draw"; this._state.selectedRoomId = null; this._drawingPoints = []; this._render(); this._closeDrawer(); };
    this._$("#btn-select").onclick = () => { this._mode = "select"; this._cancelDraw(); this._render(); };
    this._$("#measure-toggle").onchange = () => this._renderCanvas();
    this._$("#add-floor").onclick = () => {
      const n = this._state.floors.length + 1;
      const floor = { id: "floor-" + Math.random().toString(36).slice(2, 9), name: "Floor " + n, vertices: {}, rooms: [] };
      this._state.floors.push(floor); this._state.currentFloorId = floor.id; this._state.selectedRoomId = null;
      this._render();
      this._persist();
    };

    // ---------- Mobile drawer ----------
    const sidebarEl = this._$("#sidebar");
    const backdropEl = this._$("#sidebar-backdrop");
    this._closeDrawer = () => { sidebarEl.classList.remove("open"); backdropEl.classList.remove("open"); };
    this._$("#hamburger").onclick = () => {
      sidebarEl.classList.contains("open") ? this._closeDrawer() : (sidebarEl.classList.add("open"), backdropEl.classList.add("open"));
    };
    backdropEl.onclick = this._closeDrawer;

    // Gated on _pointerOverCanvas: these are window-level listeners (so
    // Escape/Enter/Backspace work without needing the SVG itself focused),
    // but without the gate they'd fire no matter where keyboard focus is
    // on the whole HA dashboard — stealing keystrokes from a search box or
    // another card entirely.
    window.addEventListener("keydown", (e) => {
      if (!this._pointerOverCanvas) return;
      if (e.key === "Escape") { if (this._mode === "draw") this._cancelDraw(); this._state.selectedRoomId = null; this._mode = "select"; this._render(); }
      if (e.key === "Enter" && this._mode === "draw") this._finishRoom();
      if (e.key === "Backspace" && this._mode === "draw" && this._drawingPoints.length) { this._drawingPoints.pop(); this._renderCanvas(); }
      if (e.key === "m" || e.key === "M") {
        if (!this._isPanKeyHeld) { this._isPanKeyHeld = true; this._svg.style.cursor = "grab"; }
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "m" || e.key === "M") {
        this._isPanKeyHeld = false;
        if (!this._dragging) this._svg.style.cursor = "";
      }
    });

    // ---------- Zoom controls ----------
    this._$("#zoom-in").onclick = () => this._applyZoom(this._zoomIndex + 1, this._canvasCenter());
    this._$("#zoom-out").onclick = () => this._applyZoom(this._zoomIndex - 1, this._canvasCenter());
    this._$("#zoom-level").onclick = () => this._applyZoom(2, this._canvasCenter());
    this._svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      this._applyZoom(this._zoomIndex + dir, this._screenPoint(e));
    }, { passive: false });
    this._updateZoomLabel();

    // ---------- Export / Import (manual escape hatch alongside config persistence) ----------
    this._$("#btn-export").onclick = () => {
      const blob = new Blob([JSON.stringify(this._state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "floorplan.json"; a.click();
      URL.revokeObjectURL(url);
    };
    this._$("#btn-import").onclick = () => this._$("#file-input").click();
    this._$("#file-input").onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.floors) { this._state = data; this._render(); this._persist(); }
        } catch (err) { alert("Invalid JSON file"); }
      };
      reader.readAsText(file);
      e.target.value = "";
    };
  }

  // ---------- Editable wall length ----------
  _startLengthEdit(edge, lx, ly, currentLenPx) {
    const existing = this.shadowRoot.getElementById("length-input");
    if (existing) existing.remove();
    const rect = this._svg.getBoundingClientRect();
    const screen = screenFromWorld(this._view, lx, ly);
    const input = document.createElement("input");
    input.id = "length-input";
    input.value = fmtLength(currentLenPx, PX_PER_METER);
    input.style.position = "fixed";
    input.style.left = (rect.left + screen.x - 30) + "px";
    input.style.top = (rect.top + screen.y - 9) + "px";
    input.style.zIndex = "10";
    input.style.font = "11px var(--mono, monospace)";
    input.style.width = "60px";
    input.style.textAlign = "center";
    // Appended to the real document body, not the shadow root: a
    // shadow-DOM-scoped absolutely-positioned input measured against the
    // svg's real getBoundingClientRect (page coordinates) still needs to
    // sit in the top-level document to paint above everything else on the
    // dashboard, not just within this card's own stacking context.
    document.body.appendChild(input);
    input.focus(); input.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const meters = parseFloat(input.value);
      input.remove();
      if (isNaN(meters) || meters <= 0) return;
      const result = tryResizeWall(this._currentFloor(), edge, meters * PX_PER_METER);
      if (!result.ok) this._flashWarn();
      this._render();
      this._persist();
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      input.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }
}

customElements.define("floorplan-card", FloorplanCard);
