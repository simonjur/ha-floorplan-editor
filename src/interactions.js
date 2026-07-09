// Interaction logic: the decisions made in response to user input (mouse,
// touch, keyboard) — snapping, whether a room can be placed, how a drag
// resolves, zoom math. Everything here is plain data in, plain data out (or
// a mutation of the floor/view object it's explicitly given) — no DOM, no
// rendering, no addEventListener.
//
// That split matters because this is precisely the code that caused every
// bug in SPEC.md: an off-by-one or a coordinate-space mixup here is cheap
// to get wrong and, before this refactor, impossible to unit-test in
// isolation because it was tangled up with SVG element creation. See
// SPEC.md for the invariants these functions are responsible for.

import { roomPolygon, polygonsOverlap, anyOverlap, roomsUsingVertex } from './geometry.js';

export function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

export function fmtLength(px, pxPerMeter) {
  return (px / pxPerMeter).toFixed(2);
}

// ---------- Coordinates ----------

export function worldFromScreen(view, sx, sy) {
  return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom };
}

export function screenFromWorld(view, wx, wy) {
  return { x: wx * view.zoom + view.panX, y: wy * view.zoom + view.panY };
}

// ---------- Edges ----------

/** Every wall on a floor, deduplicated so a wall shared by two rooms appears once. */
export function uniqueEdges(floor) {
  const map = new Map();
  floor.rooms.forEach((room) => {
    const n = room.vertexIds.length;
    for (let i = 0; i < n; i++) {
      const a = room.vertexIds[i], b = room.vertexIds[(i + 1) % n];
      const key = [a, b].sort().join('|');
      if (!map.has(key)) map.set(key, { a, b, roomIds: [] });
      map.get(key).roomIds.push(room.id);
    }
  });
  return [...map.values()];
}

// ---------- Snapping ----------

/**
 * Decide where a raw world-space point should actually land: grid-snapped,
 * and optionally weld-snapped onto an existing vertex or aligned to one on
 * an axis. Returns the resolved point plus any alignment guide lines to
 * draw — this only computes where they'd go, the caller renders them.
 */
export function snapPoint(floor, view, rawX, rawY, excludeVid, opts) {
  const { snapToGrid, grid, weldDist, axisDist } = opts;
  const snapGrid = (v) => (snapToGrid ? Math.round(v / grid) * grid : Math.round(v));
  let x = snapGrid(rawX), y = snapGrid(rawY);
  const guides = [];

  // Thresholds are screen-pixel distances; convert to world units by
  // dividing by zoom so snapping feels consistent regardless of zoom level.
  const weldDistWorld = weldDist / view.zoom;
  const axisDistWorld = axisDist / view.zoom;

  let best = null, bestDist = weldDistWorld;
  for (const vid in floor.vertices) {
    if (vid === excludeVid) continue;
    const v = floor.vertices[vid];
    const d = Math.hypot(v.x - rawX, v.y - rawY);
    if (d < bestDist) { bestDist = d; best = vid; }
  }
  if (best) {
    return { x: floor.vertices[best].x, y: floor.vertices[best].y, weldVid: best, guides };
  }

  for (const vid in floor.vertices) {
    if (vid === excludeVid) continue;
    const v = floor.vertices[vid];
    if (Math.abs(v.x - rawX) < axisDistWorld) {
      x = v.x;
      guides.push({ x1: x, y1: -10000, x2: x, y2: 10000 });
    }
    if (Math.abs(v.y - rawY) < axisDistWorld) {
      y = v.y;
      guides.push({ x1: -10000, y1: y, x2: 10000, y2: y });
    }
  }
  return { x, y, weldVid: null, guides };
}

// ---------- Drawing a room ----------

/**
 * Attempt to turn a finished set of drawn points into a room on the floor.
 * Mutates `floor` (adding vertices + the room) only if accepted; on
 * rejection, floor is left exactly as it was.
 */
export function tryAddRoom(floor, drawingPoints, colors, colorIndex, name) {
  if (drawingPoints.length < 3) return { ok: false, reason: 'too-few-points' };

  const newVertexIds = [];
  const vertexIds = drawingPoints.map((p) => {
    if (p.weldVid) return p.weldVid;
    const vid = uid('v');
    newVertexIds.push(vid);
    floor.vertices[vid] = { x: p.x, y: p.y };
    return vid;
  });
  const color = colors[colorIndex % colors.length];
  const room = { id: uid('room'), name, vertexIds, color, entities: [] };

  const testPoly = roomPolygon(room, floor);
  const overlaps = floor.rooms.some((other) => polygonsOverlap(testPoly, roomPolygon(other, floor)));
  if (overlaps) {
    newVertexIds.forEach((vid) => delete floor.vertices[vid]);
    return { ok: false, reason: 'overlap' };
  }

  floor.rooms.push(room);
  return { ok: true, room };
}

/** Remove a room, and any of its vertices not shared by another room. */
export function deleteRoom(floor, roomId) {
  const room = floor.rooms.find((r) => r.id === roomId);
  if (!room) return;
  const removedVids = room.vertexIds.filter((vid) => roomsUsingVertex(floor, vid).length === 1);
  floor.rooms = floor.rooms.filter((r) => r.id !== roomId);
  removedVids.forEach((vid) => delete floor.vertices[vid]);
}

// ---------- Dragging ----------

/** Attempt to move a single vertex, reverting if the result would overlap another room. */
export function tryMoveVertex(floor, vid, newPos) {
  const prev = { ...floor.vertices[vid] };
  floor.vertices[vid] = { ...newPos };
  const affected = roomsUsingVertex(floor, vid);
  if (anyOverlap(floor, affected)) {
    floor.vertices[vid] = prev;
    return { ok: false };
  }
  return { ok: true };
}

/** Attempt to translate a whole room by (dx, dy) from its drag-start snapshot, reverting if it would overlap another room. */
export function tryTranslateRoom(floor, room, snapshot, dx, dy) {
  const prevPositions = room.vertexIds.map((vid) => ({ ...floor.vertices[vid] }));
  room.vertexIds.forEach((vid) => {
    const orig = snapshot[vid];
    floor.vertices[vid] = { x: orig.x + dx, y: orig.y + dy };
  });
  if (anyOverlap(floor, [room.id])) {
    room.vertexIds.forEach((vid, i) => { floor.vertices[vid] = prevPositions[i]; });
    return { ok: false };
  }
  return { ok: true };
}

/**
 * On releasing a vertex drag, merge it into any other vertex it's now
 * sitting exactly on top of — this is what lets a dragged corner "weld"
 * onto an existing wall and share it going forward.
 */
export function weldVertexOnRelease(floor, vid) {
  const pos = floor.vertices[vid];
  for (const otherVid in floor.vertices) {
    if (otherVid === vid) continue;
    const v = floor.vertices[otherVid];
    if (Math.hypot(v.x - pos.x, v.y - pos.y) < 1) {
      floor.rooms.forEach((r) => { r.vertexIds = r.vertexIds.map((x) => (x === vid ? otherVid : x)); });
      delete floor.vertices[vid];
      return { welded: true, into: otherVid };
    }
  }
  return { welded: false };
}

// ---------- Wall length editing ----------

/**
 * Move edge.b to make the wall the requested length, keeping edge.a fixed.
 * Reverts if the result would overlap another room. Any other room/wall
 * sharing vertex b moves with it automatically — see SPEC.md, "Data model."
 */
export function tryResizeWall(floor, edge, newLenPx) {
  const a = floor.vertices[edge.a], b = floor.vertices[edge.b];
  const dx = b.x - a.x, dy = b.y - a.y;
  const curLen = Math.hypot(dx, dy);
  if (curLen < 0.001) return { ok: false };
  const ux = dx / curLen, uy = dy / curLen;
  const prevB = { ...b };
  floor.vertices[edge.b] = { x: a.x + ux * newLenPx, y: a.y + uy * newLenPx };
  const affected = roomsUsingVertex(floor, edge.b);
  if (anyOverlap(floor, affected)) {
    floor.vertices[edge.b] = prevB;
    return { ok: false };
  }
  return { ok: true };
}

// ---------- Zoom ----------

/**
 * Compute the new pan/zoom state for moving to `newIndex` in `zoomLevels`,
 * keeping the world point currently under `screenCenter` fixed on screen —
 * this is what makes wheel-zoom feel like it's zooming "into" the cursor
 * instead of the whole view jumping. Returns null if the index is
 * out-of-range/unchanged (caller should no-op).
 */
export function computeZoomTransition(zoomLevels, currentIndex, newIndex, view, screenCenter) {
  const clamped = Math.max(0, Math.min(zoomLevels.length - 1, newIndex));
  if (clamped === currentIndex) return null;
  const worldPt = worldFromScreen(view, screenCenter.x, screenCenter.y);
  const zoom = zoomLevels[clamped];
  return {
    index: clamped,
    view: {
      zoom,
      panX: screenCenter.x - worldPt.x * zoom,
      panY: screenCenter.y - worldPt.y * zoom,
    },
  };
}
