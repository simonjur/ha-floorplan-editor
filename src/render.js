// DOM rendering for the floor plan editor. Every function here takes
// explicit DOM references and plain state as parameters — no closures over
// module-level globals — which is what makes it possible to test these
// with jsdom instead of only ever through a full browser.
//
// This module only builds/updates the DOM to reflect state; it does not
// decide what a click or drag means (see interactions.js for that).
// Callbacks passed in via `handlers` are expected to already contain
// whatever decision logic they need — render.js just wires them up.

import { roomPolygon, polygonCentroid } from './geometry.js';
import { uniqueEdges } from './interactions.js';

const NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/**
 * Screen-space grid (not inside the pan/zoom transform) so lines stay a
 * crisp 1px regardless of zoom, like a map tile grid — spacing/offset are
 * derived from the current view so it still lines up with content.
 */
export function renderGrid(svg, view, grid) {
  const rect = svg.getBoundingClientRect();
  const g = el('g');
  const step = grid * view.zoom;
  if (step < 4) return g; // too dense to be useful, skip drawing it
  const offsetX = ((view.panX % step) + step) % step;
  const offsetY = ((view.panY % step) + step) % step;
  for (let x = offsetX; x < rect.width; x += step) g.appendChild(el('line', { x1: x, y1: 0, x2: x, y2: rect.height, stroke: 'var(--grid-line)' }));
  for (let y = offsetY; y < rect.height; y += step) g.appendChild(el('line', { x1: 0, y1: y, x2: rect.width, y2: y, stroke: 'var(--grid-line)' }));
  return g;
}

/**
 * A wall's length label, offset outward from its owning room (see
 * SPEC.md, "Overlap rules" sibling note on measurement labels) or kept on
 * the line itself for a wall shared by two rooms, which has no true
 * "outside."
 */
export function renderMeasurementLabel(parent, floor, edge, fmtLength, onEdit) {
  const a = floor.vertices[edge.a], b = floor.vertices[edge.b];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return null;
  let angle = Math.atan2(dy, dx) * 180 / Math.PI;
  if (angle > 90 || angle < -90) angle += 180;

  let nx = -dy / len, ny = dx / len;
  let offset = edge.roomIds.length > 1 ? 0 : 12;
  if (offset > 0) {
    const room = floor.rooms.find((r) => r.id === edge.roomIds[0]);
    if (room) {
      const centroid = polygonCentroid(roomPolygon(room, floor));
      const toMidX = mx - centroid[0], toMidY = my - centroid[1];
      if (nx * toMidX + ny * toMidY < 0) { nx = -nx; ny = -ny; }
    }
  }
  const lx = mx + nx * offset, ly = my + ny * offset;

  const g = el('g', { transform: `rotate(${angle}, ${lx}, ${ly})` });
  const text = fmtLength(len) + ' m';
  const bg = el('rect', { x: lx - text.length * 3 - 4, y: ly - 8, width: text.length * 6 + 8, height: 16, rx: 3, class: 'measure-hit' });
  const label = el('text', { x: lx, y: ly + 1, class: 'measure-text' });
  label.textContent = text;
  g.appendChild(bg);
  g.appendChild(label);
  g.addEventListener('pointerdown', (e) => e.stopPropagation());
  g.addEventListener('click', (e) => { e.stopPropagation(); onEdit(edge, lx, ly, len); });
  parent.appendChild(g);
  return g;
}

/**
 * Rebuild the whole canvas: grid, the pan/zoom-transformed content group
 * (rooms, vertex handles, measurements, in-progress draft), from scratch.
 *
 * `appState` is a plain snapshot: { floor, selectedRoomId, invalidRoomIds,
 * guides, mode, drawingPoints, mousePos, view, showMeasurements }.
 * `handlers` supplies onRoomPointerDown(e, room), onVertexPointerDown(e,
 * vid), and onMeasurementEdit(edge, lx, ly, lenPx).
 */
export function renderCanvas(svg, appState, grid, fmtLength, handlers) {
  const { floor, selectedRoomId, invalidRoomIds, guides, mode, drawingPoints, mousePos, view, showMeasurements } = appState;

  svg.innerHTML = '';
  svg.appendChild(renderGrid(svg, view, grid));

  const contentG = el('g', { transform: `translate(${view.panX},${view.panY}) scale(${view.zoom})` });
  svg.appendChild(contentG);

  guides.forEach((g) => contentG.appendChild(el('line', { ...g, class: 'guide-line' })));

  if (!floor) return;

  floor.rooms.forEach((room) => {
    const isSelected = room.id === selectedRoomId;
    const isInvalid = invalidRoomIds.has(room.id);
    const poly = roomPolygon(room, floor);
    const pts = poly.map((p) => p.join(',')).join(' ');
    const polyEl = el('polygon', {
      points: pts,
      class: 'room-polygon' + (isSelected ? ' selected' : '') + (isInvalid ? ' invalid' : ''),
      style: isInvalid ? '' : `stroke:${room.color}; fill:${room.color}33;`,
    });
    polyEl.addEventListener('pointerdown', (e) => handlers.onRoomPointerDown(e, room));
    contentG.appendChild(polyEl);

    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const label = el('text', { x: cx, y: cy, class: 'room-label', 'text-anchor': 'middle' });
    label.textContent = room.name;
    contentG.appendChild(label);

    if (isSelected) {
      room.vertexIds.forEach((vid) => {
        const v = floor.vertices[vid];
        const handle = el('circle', { cx: v.x, cy: v.y, r: 6, class: 'vertex-handle' });
        handle.addEventListener('pointerdown', (e) => handlers.onVertexPointerDown(e, vid));
        contentG.appendChild(handle);
      });
    }
  });

  if (showMeasurements) {
    uniqueEdges(floor).forEach((edge) => renderMeasurementLabel(contentG, floor, edge, fmtLength, handlers.onMeasurementEdit));
  }

  if (mode === 'draw' && drawingPoints.length > 0) {
    const linePts = drawingPoints.map((p) => `${p.x},${p.y}`).join(' ') + ` ${mousePos.x},${mousePos.y}`;
    contentG.appendChild(el('polyline', { points: linePts, class: 'draft-line' }));
    drawingPoints.forEach((p, i) => {
      contentG.appendChild(el('circle', { cx: p.x, cy: p.y, r: i === 0 ? 7 : 4, class: 'draft-point' + (i === 0 ? ' first' : '') }));
    });
  }
}

/** `handlers.onSelectRoom(roomId)`. */
export function renderRoomList(roomListEl, floor, selectedRoomId, handlers) {
  roomListEl.innerHTML = '';
  if (!floor || floor.rooms.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="empty">No rooms yet — click "Draw Room"</span>';
    roomListEl.appendChild(li);
    return;
  }
  floor.rooms.forEach((room) => {
    const li = document.createElement('li');
    li.className = room.id === selectedRoomId ? 'selected' : '';
    li.innerHTML = `<span class="swatch" style="background:${room.color}"></span><span class="name">${room.name}</span>`;
    li.onclick = () => handlers.onSelectRoom(room.id);
    roomListEl.appendChild(li);
  });
}

/** `handlers.onSelectFloor(floorId)`. */
export function renderFloorTabs(floorTabsEl, floors, currentFloorId, handlers) {
  floorTabsEl.innerHTML = '';
  floors.forEach((f) => {
    const tab = document.createElement('button');
    tab.className = 'floor-tab' + (f.id === currentFloorId ? ' active' : '');
    tab.textContent = f.name;
    tab.onclick = () => handlers.onSelectFloor(f.id);
    floorTabsEl.appendChild(tab);
  });
}

/** `handlers.onRename(newName)`, `handlers.onDelete()`. */
export function renderInspector(inspectorEl, room, handlers) {
  if (!room) {
    inspectorEl.innerHTML = '<div class="empty">Select a room to edit its name, or bind entities in a later step.</div>';
    return;
  }
  inspectorEl.innerHTML = `
    <input type="text" id="room-name-input" value="${room.name}">
    <div class="row"><button id="btn-delete-room" class="danger">Delete room</button></div>
    <div class="entity-note">Entity binding comes in the next step. Corners: ${room.vertexIds.length}</div>
  `;
  inspectorEl.querySelector('#room-name-input').oninput = (e) => handlers.onRename(e.target.value);
  inspectorEl.querySelector('#btn-delete-room').onclick = () => handlers.onDelete();
}
