// Unit tests for src/interactions.js. Pure logic, no DOM — run with
// `node --test test/*.test.js`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  worldFromScreen,
  screenFromWorld,
  uniqueEdges,
  snapPoint,
  tryAddRoom,
  deleteRoom,
  tryMoveVertex,
  tryTranslateRoom,
  weldVertexOnRelease,
  tryResizeWall,
  computeZoomTransition,
  fmtLength,
} from '../src/interactions.js';

const COLORS = ['#5b8def', '#4fd1c5'];
const SNAP_OPTS = { snapToGrid: true, grid: 25, weldDist: 12, axisDist: 7 };

function makeFloor(roomDefs = {}) {
  // roomDefs: { roomId: [[x,y], ...] }; identical coordinates automatically
  // become the same shared vertex, mirroring the app's weld-on-drag.
  const vertices = {};
  const vidFor = (x, y) => {
    const key = `${x},${y}`;
    if (!vertices[key]) vertices[key] = { x, y };
    return key;
  };
  const rooms = Object.entries(roomDefs).map(([id, points]) => ({
    id, name: id, color: '#fff', entities: [],
    vertexIds: points.map(([x, y]) => vidFor(x, y)),
  }));
  return { id: 'floor-1', name: 'Floor', vertices, rooms };
}

const rectA = [[100, 100], [300, 100], [300, 220], [100, 220]];
const rectAdjacentRight = [[300, 100], [500, 100], [500, 220], [300, 220]];

describe('coordinate conversion', () => {
  test('screenFromWorld and worldFromScreen round-trip', () => {
    const view = { panX: 40, panY: -15, zoom: 1.5 };
    const world = { x: 123.4, y: -56.7 };
    const screen = screenFromWorld(view, world.x, world.y);
    const back = worldFromScreen(view, screen.x, screen.y);
    assert.ok(Math.abs(back.x - world.x) < 1e-9);
    assert.ok(Math.abs(back.y - world.y) < 1e-9);
  });
});

describe('uniqueEdges', () => {
  test('a wall shared by two rooms appears once, listing both room ids', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    const edges = uniqueEdges(floor);
    assert.equal(edges.length, 7); // 4 + 4 - 1 shared
    const shared = edges.find((e) => e.roomIds.length === 2);
    assert.ok(shared);
    assert.deepEqual(shared.roomIds.sort(), ['A', 'B']);
  });
});

describe('snapPoint', () => {
  const floor = makeFloor({ A: rectA });
  const view = { panX: 0, panY: 0, zoom: 1 };

  test('snaps to the grid when nothing nearby', () => {
    const result = snapPoint(floor, view, 613, 588, null, SNAP_OPTS);
    assert.equal(result.x, 625); // nearest multiple of 25
    assert.equal(result.y, 600);
    assert.equal(result.weldVid, null);
  });

  test('welds onto an existing vertex within threshold', () => {
    const result = snapPoint(floor, view, 305, 103, null, SNAP_OPTS); // near (300,100)
    assert.equal(result.x, 300);
    assert.equal(result.y, 100);
    assert.notEqual(result.weldVid, null);
  });

  test('produces an axis guide when aligned but too far to weld', () => {
    const result = snapPoint(floor, view, 300, 500, null, SNAP_OPTS); // same x as a vertex, far away
    assert.equal(result.weldVid, null);
    assert.equal(result.x, 300);
    assert.ok(result.guides.length > 0);
  });

  test('weld threshold scales with zoom (screen-pixel feel stays constant)', () => {
    const zoomedView = { panX: 0, panY: 0, zoom: 2 };
    // 8 world units away — at zoom 1 that's within the 12px threshold, but
    // at zoom 2 the same world distance is 16 screen px, outside it.
    const near = snapPoint(floor, view, 308, 100, null, SNAP_OPTS);
    const zoomed = snapPoint(floor, zoomedView, 308, 100, null, SNAP_OPTS);
    assert.notEqual(near.weldVid, null);
    assert.equal(zoomed.weldVid, null);
  });
});

describe('tryAddRoom', () => {
  test('rejects fewer than 3 points', () => {
    const floor = makeFloor();
    const result = tryAddRoom(floor, [{ x: 0, y: 0 }, { x: 10, y: 0 }], COLORS, 0, 'Room 1');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too-few-points');
  });

  test('accepts a valid non-overlapping room', () => {
    const floor = makeFloor();
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const result = tryAddRoom(floor, points, COLORS, 0, 'Room 1');
    assert.equal(result.ok, true);
    assert.equal(floor.rooms.length, 1);
    assert.equal(Object.keys(floor.vertices).length, 4);
  });

  test('rejects an overlapping room and leaves the floor unchanged', () => {
    const floor = makeFloor({ A: rectA });
    const vertexCountBefore = Object.keys(floor.vertices).length;
    const points = [{ x: 200, y: 150 }, { x: 400, y: 150 }, { x: 400, y: 270 }, { x: 200, y: 270 }];
    const result = tryAddRoom(floor, points, COLORS, 1, 'Room 2');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'overlap');
    assert.equal(floor.rooms.length, 1);
    assert.equal(Object.keys(floor.vertices).length, vertexCountBefore);
  });

  test('reuses an existing vertex id when a point carries a weldVid, instead of creating a new one', () => {
    const floor = makeFloor({ A: rectA });
    const existingVid = Object.keys(floor.vertices).find((vid) => {
      const v = floor.vertices[vid];
      return v.x === 300 && v.y === 100;
    });
    const points = [
      { x: 300, y: 100, weldVid: existingVid },
      { x: 500, y: 100 },
      { x: 500, y: 220 },
      { x: 300, y: 220, weldVid: null },
    ];
    const before = Object.keys(floor.vertices).length;
    const result = tryAddRoom(floor, points, COLORS, 1, 'Room 2');
    assert.equal(result.ok, true);
    assert.equal(result.room.vertexIds[0], existingVid);
    // 3 new vertices added (the 4th point reused the welded one)
    assert.equal(Object.keys(floor.vertices).length, before + 3);
  });
});

describe('deleteRoom', () => {
  test('removes the room and its unshared vertices', () => {
    const floor = makeFloor({ A: rectA });
    deleteRoom(floor, 'A');
    assert.equal(floor.rooms.length, 0);
    assert.equal(Object.keys(floor.vertices).length, 0);
  });

  test('keeps vertices still shared by another room', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    const vertexCountBefore = Object.keys(floor.vertices).length;
    deleteRoom(floor, 'A');
    assert.equal(floor.rooms.length, 1);
    // Only A's two unshared corners should be gone; the two shared with B remain.
    assert.equal(Object.keys(floor.vertices).length, vertexCountBefore - 2);
  });
});

describe('tryMoveVertex / tryTranslateRoom', () => {
  test('tryMoveVertex accepts a move that stays clear of other rooms', () => {
    const floor = makeFloor({ A: rectA });
    const vid = Object.keys(floor.vertices)[0];
    const result = tryMoveVertex(floor, vid, { x: 900, y: 900 });
    assert.equal(result.ok, true);
    assert.deepEqual(floor.vertices[vid], { x: 900, y: 900 });
  });

  test('tryMoveVertex reverts a move that would overlap another room', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    // Use B's own far corner (not the wall shared with A) so moving it
    // only reshapes B, making this a clean test of "into an unrelated room".
    const vid = Object.keys(floor.vertices).find((v) => {
      const p = floor.vertices[v];
      return p.x === 500 && p.y === 100;
    });
    const original = { ...floor.vertices[vid] };
    const result = tryMoveVertex(floor, vid, { x: 150, y: 150 }); // deep into A's interior
    assert.equal(result.ok, false);
    assert.deepEqual(floor.vertices[vid], original);
  });

  test('tryTranslateRoom reverts a full-duplicate-overlap drag (regression: this exact case shipped as a bug)', () => {
    // Deliberately independent rooms (no shared wall) so this tests a clean
    // "drag one room onto an unrelated one" — see the dedicated shared-wall
    // test below for what happens when rooms DO share vertices.
    const floor = makeFloor({ A: rectA });
    const farPoints = [{ x: 700, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 220 }, { x: 700, y: 220 }];
    tryAddRoom(floor, farPoints, COLORS, 1, 'B');
    const roomB = floor.rooms.find((r) => r.name === 'B');
    const snapshot = {};
    roomB.vertexIds.forEach((vid) => { snapshot[vid] = { ...floor.vertices[vid] }; });
    // Drag B on top of A entirely (B was at x:700-900, A is at x:100-300 — a -600 shift lands B exactly on A).
    const result = tryTranslateRoom(floor, roomB, snapshot, -600, 0);
    assert.equal(result.ok, false);
    roomB.vertexIds.forEach((vid) => {
      assert.deepEqual(floor.vertices[vid], snapshot[vid]);
    });
  });

  test('dragging a room that shares a wall with another also moves the shared corner (documented current behavior, not asserted as ideal)', () => {
    // Because shared vertices are literally the same object (see SPEC.md,
    // "Data model"), translating a room that shares a wall with a neighbor
    // necessarily drags the neighbor's corner along with it too — there is
    // currently no "detach on drag" step. Whether that's the desired UX is
    // an open question (see SPEC.md); this test exists so a future change
    // to that behavior is a deliberate decision, not a silent regression.
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    const roomA = floor.rooms.find((r) => r.id === 'A');
    const roomB = floor.rooms.find((r) => r.id === 'B');
    const snapshot = {};
    roomB.vertexIds.forEach((vid) => { snapshot[vid] = { ...floor.vertices[vid] }; });
    const sharedVid = roomA.vertexIds.find((vid) => roomB.vertexIds.includes(vid));
    const aPosBefore = { ...floor.vertices[sharedVid] };
    tryTranslateRoom(floor, roomB, snapshot, 0, 50); // slide B straight down, away from A
    assert.notDeepEqual(floor.vertices[sharedVid], aPosBefore);
  });

  test('tryTranslateRoom accepts sliding a room to newly touch another (not overlap)', () => {
    const floor = makeFloor({ A: rectA });
    const points = [{ x: 400, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 220 }, { x: 400, y: 220 }];
    tryAddRoom(floor, points, COLORS, 1, 'B');
    const roomB = floor.rooms.find((r) => r.name === 'B');
    const snapshot = {};
    roomB.vertexIds.forEach((vid) => { snapshot[vid] = { ...floor.vertices[vid] }; });
    const result = tryTranslateRoom(floor, roomB, snapshot, -100, 0); // slides B's left wall onto A's right wall
    assert.equal(result.ok, true);
  });
});

describe('weldVertexOnRelease', () => {
  test('merges a vertex into another it now exactly coincides with', () => {
    const floor = makeFloor({ A: rectA });
    const points = [{ x: 700, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 200 }];
    tryAddRoom(floor, points, COLORS, 1, 'B');
    const roomB = floor.rooms.find((r) => r.name === 'B');
    const looseVid = roomB.vertexIds[0];
    // Move it to sit exactly on top of one of A's vertices.
    floor.vertices[looseVid] = { x: 300, y: 100 };
    const targetVid = Object.keys(floor.vertices).find((vid) => vid !== looseVid && floor.vertices[vid].x === 300 && floor.vertices[vid].y === 100);
    const result = weldVertexOnRelease(floor, looseVid);
    assert.equal(result.welded, true);
    assert.equal(result.into, targetVid);
    assert.equal(floor.vertices[looseVid], undefined);
    assert.ok(roomB.vertexIds.includes(targetVid));
  });

  test('does nothing when not coinciding with any other vertex', () => {
    const floor = makeFloor({ A: rectA });
    const vid = Object.keys(floor.vertices)[0];
    const result = weldVertexOnRelease(floor, vid);
    assert.equal(result.welded, false);
  });
});

describe('tryResizeWall', () => {
  test('moves the far endpoint to hit the requested length, anchor fixed', () => {
    const floor = makeFloor({ A: rectA }); // top wall from (100,100) to (300,100), length 200
    const vids = Object.keys(floor.vertices);
    const aVid = vids.find((v) => floor.vertices[v].x === 100 && floor.vertices[v].y === 100);
    const bVid = vids.find((v) => floor.vertices[v].x === 300 && floor.vertices[v].y === 100);
    const result = tryResizeWall(floor, { a: aVid, b: bVid }, 400);
    assert.equal(result.ok, true);
    assert.deepEqual(floor.vertices[aVid], { x: 100, y: 100 }); // anchor unchanged
    assert.equal(floor.vertices[bVid].x, 500); // 100 + 400
    assert.equal(floor.vertices[bVid].y, 100);
  });

  test('rejects a resize that would cause an overlap, leaving the wall unchanged', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    const vids = Object.keys(floor.vertices);
    const aVid = vids.find((v) => floor.vertices[v].x === 100 && floor.vertices[v].y === 100);
    const bVid = vids.find((v) => floor.vertices[v].x === 300 && floor.vertices[v].y === 100);
    const before = { ...floor.vertices[bVid] };
    const result = tryResizeWall(floor, { a: aVid, b: bVid }, 1000); // would push straight through B
    assert.equal(result.ok, false);
    assert.deepEqual(floor.vertices[bVid], before);
  });

  test('resizing a wall shared with another room moves that room\'s wall too (same vertex)', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    const vids = Object.keys(floor.vertices);
    // The shared wall is A's right / B's left: (300,100)-(300,220), vertical.
    const aVid = vids.find((v) => floor.vertices[v].x === 300 && floor.vertices[v].y === 220);
    const bVid = vids.find((v) => floor.vertices[v].x === 300 && floor.vertices[v].y === 100);
    const roomB = floor.rooms.find((r) => r.id === 'B');
    // B's own top-right corner (500,100) is unaffected by this resize — use
    // it as a fixed reference to measure B's height before/after.
    const bFixedCorner = roomB.vertexIds.find((vid) => floor.vertices[vid].x === 500 && floor.vertices[vid].y === 100);
    const bHeightBefore = Math.abs(floor.vertices[bVid].y - floor.vertices[bFixedCorner].y);
    tryResizeWall(floor, { a: aVid, b: bVid }, 60); // shrink the shared wall from 120 to 60
    const bHeightAfter = Math.abs(floor.vertices[bVid].y - floor.vertices[bFixedCorner].y);
    assert.notEqual(bHeightBefore, bHeightAfter);
    assert.equal(bHeightAfter, 60);
  });
});

describe('computeZoomTransition', () => {
  const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2];

  test('keeps the world point under screenCenter fixed on screen', () => {
    const view = { panX: 0, panY: 0, zoom: 1 };
    const screenCenter = { x: 400, y: 300 };
    const worldBefore = worldFromScreen(view, screenCenter.x, screenCenter.y);
    const transition = computeZoomTransition(ZOOM_LEVELS, 2, 3, view, screenCenter);
    const worldAfter = worldFromScreen(transition.view, screenCenter.x, screenCenter.y);
    assert.ok(Math.abs(worldAfter.x - worldBefore.x) < 1e-9);
    assert.ok(Math.abs(worldAfter.y - worldBefore.y) < 1e-9);
  });

  test('clamps at the top of the zoom range', () => {
    const view = { panX: 0, panY: 0, zoom: 2 };
    const transition = computeZoomTransition(ZOOM_LEVELS, 4, 10, view, { x: 0, y: 0 });
    assert.equal(transition, null);
  });

  test('clamps at the bottom of the zoom range', () => {
    const view = { panX: 0, panY: 0, zoom: 0.5 };
    const transition = computeZoomTransition(ZOOM_LEVELS, 0, -5, view, { x: 0, y: 0 });
    assert.equal(transition, null);
  });

  test('returns null when the index does not change', () => {
    const view = { panX: 0, panY: 0, zoom: 1 };
    const transition = computeZoomTransition(ZOOM_LEVELS, 2, 2, view, { x: 0, y: 0 });
    assert.equal(transition, null);
  });
});

describe('fmtLength', () => {
  test('formats pixels as meters to 2 decimal places', () => {
    assert.equal(fmtLength(250, 50), '5.00');
    assert.equal(fmtLength(125, 50), '2.50');
  });
});
