// Pure geometry logic for the floor plan editor.
//
// Nothing in this file touches the DOM, SVG, or any rendering concern —
// every function takes plain data (points as [x,y], polygons as arrays of
// points, rooms/floors as plain objects) and returns plain data. That's
// what makes it possible to unit-test this in milliseconds with no browser,
// and it's also what stops "fix the bug in the HTML" from silently drifting
// out of sync with "the logic we actually tested."
//
// See SPEC.md for the invariants this module is responsible for upholding.

/**
 * Project a room's vertex-ID list into actual [x,y] points using the
 * floor's shared vertex map.
 */
export function roomPolygon(room, floor) {
  return room.vertexIds.map(vid => {
    const v = floor.vertices[vid];
    return [v.x, v.y];
  });
}

export function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function pointOnPolygonBoundary(pt, poly, eps = 0.75) {
  for (let i = 0; i < poly.length; i++) {
    if (distToSegment(pt, poly[i], poly[(i + 1) % poly.length]) < eps) return true;
  }
  return false;
}

/**
 * A point sitting exactly on the boundary (e.g. a corner shared by two
 * adjacent rooms) is ambiguous for ray-casting and can flip to "inside" due
 * to floating point — treat boundary points as not interior so rooms can
 * legitimately share a wall or corner without being flagged as overlapping.
 */
export function pointInPolygon([px, py], poly) {
  if (pointOnPolygonBoundary([px, py], poly)) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function orient(p, q, r) {
  const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  if (Math.abs(v) < 1e-6) return 0;
  return v > 0 ? 1 : 2;
}

/**
 * True only for a genuine transversal crossing (an "X" through both
 * segments' interiors) — never for segments that merely touch at a shared
 * endpoint or where one endpoint lies exactly on the other's line (a
 * T-junction, e.g. a wall's midpoint landing precisely on another room's
 * shared corner point). Both of those are legitimate contact between rooms,
 * not an overlap.
 */
export function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const EPS = 0.5;
  const sameEndpoint = [p1, p2].some(a => [p3, p4].some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS));
  if (sameEndpoint) return false;
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4);
  const o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

export function polygonCentroid(poly) {
  let cx = 0, cy = 0;
  poly.forEach(p => { cx += p[0]; cy += p[1]; });
  return [cx / poly.length, cy / poly.length];
}

export function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Two rooms may share a vertex or an edge (in full or in part) — that is
 * NOT an overlap. Any positive-area intersection of their interiors IS.
 * See SPEC.md, "Overlap rules", for the full statement of this contract
 * and why it needs three separate checks rather than one.
 */
export function polygonsOverlap(polyA, polyB) {
  // 1. A vertex of one strictly inside the other catches most partial overlaps.
  for (const v of polyA) if (pointInPolygon(v, polyB)) return true;
  for (const v of polyB) if (pointInPolygon(v, polyA)) return true;

  // 2. A genuine transversal edge crossing catches the rest of the partial-overlap cases.
  for (let i = 0; i < polyA.length; i++) {
    const a1 = polyA[i], a2 = polyA[(i + 1) % polyA.length];
    for (let j = 0; j < polyB.length; j++) {
      const b1 = polyB[j], b2 = polyB[(j + 1) % polyB.length];
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }

  // 3. Checks 1 and 2 both intentionally ignore boundary-only contact (that's
  // what lets two rooms legitimately share a wall or corner). But that means
  // a room dragged to exactly duplicate or fully sit inside another can end
  // up with every vertex sitting exactly on the other's boundary and every
  // edge exactly collinear with it — a real full-area overlap that neither
  // check above can tell apart from simple touching. Sample each polygon's
  // centroid and edge midpoints: a genuine area overlap always has points
  // strictly inside the other polygon, while legitimate sharing never does.
  const samplesA = polyA.map((p, i) => midpoint(p, polyA[(i + 1) % polyA.length])).concat([polygonCentroid(polyA)]);
  const samplesB = polyB.map((p, i) => midpoint(p, polyB[(i + 1) % polyB.length])).concat([polygonCentroid(polyB)]);
  for (const s of samplesA) if (pointInPolygon(s, polyB)) return true;
  for (const s of samplesB) if (pointInPolygon(s, polyA)) return true;

  return false;
}

/** Would any of `changedRoomIds` (evaluated against the floor's CURRENT vertex positions) overlap another room on the same floor? */
export function anyOverlap(floor, changedRoomIds) {
  const rooms = floor.rooms;
  for (const rid of changedRoomIds) {
    const room = rooms.find(r => r.id === rid);
    if (!room) continue;
    const polyA = roomPolygon(room, floor);
    for (const other of rooms) {
      if (other.id === rid) continue;
      const polyB = roomPolygon(other, floor);
      if (polygonsOverlap(polyA, polyB)) return true;
    }
  }
  return false;
}

export function roomsUsingVertex(floor, vid) {
  return floor.rooms.filter(r => r.vertexIds.includes(vid)).map(r => r.id);
}
