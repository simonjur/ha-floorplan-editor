// Regression tests for src/geometry.js.
//
// Run with: node --test test/
//
// Every test here corresponds to an actual bug that shipped and was fixed
// during development — see SPEC.md for the plain-language contract these
// are checking. The point of this file is that the NEXT feature that
// touches overlap/snap logic gets an immediate, automatic "you just broke
// scenario X" instead of a human noticing it days later in a screenshot.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  pointInPolygon,
  segmentsProperlyIntersect,
  polygonsOverlap,
  anyOverlap,
  orient,
} from '../src/geometry.js';

// ---------- Test fixtures ----------
// Plain axis-aligned rectangles, described as [x,y] corner arrays, matching
// what roomPolygon() produces. Keeping these as simple literals (rather than
// going through the room/vertex data model) keeps these tests fast and
// focused purely on the geometry, independent of how the app stores rooms.

const rectA = [[100, 100], [300, 100], [300, 220], [100, 220]]; // 200x120
const rectAdjacentRight = [[300, 100], [500, 100], [500, 220], [300, 220]]; // shares A's right wall exactly
const rectSharedCorner = [[300, 220], [500, 220], [500, 340], [300, 340]]; // touches A at one corner only
const rectVennOverlap = [[200, 150], [400, 150], [400, 270], [200, 270]]; // genuinely overlaps A
const rectFullDuplicate = [[100, 100], [300, 100], [300, 220], [100, 220]]; // identical to A
const rectVertexInsideA = [[200, 160], [400, 300], [400, 400], [200, 400]]; // one corner strictly inside A
const rectCutsThroughViaBoundaryCorners = [[200, 100], [400, 100], [400, 220], [200, 220]]; // edge cuts A's interior, corners land on A's boundary

describe('pointInPolygon', () => {
  test('a point in the interior is inside', () => {
    assert.equal(pointInPolygon([200, 160], rectA), true);
  });
  test('a point exactly on the boundary is NOT interior (needed so rooms can share a wall/corner)', () => {
    assert.equal(pointInPolygon([300, 160], rectA), false); // on the right edge
    assert.equal(pointInPolygon([300, 220], rectA), false); // exactly a corner
  });
  test('a point clearly outside is not interior', () => {
    assert.equal(pointInPolygon([1000, 1000], rectA), false);
  });
});

describe('segmentsProperlyIntersect', () => {
  test('a genuine X-crossing is detected', () => {
    assert.equal(segmentsProperlyIntersect([0, 0], [10, 10], [0, 10], [10, 0]), true);
  });
  test('segments sharing an endpoint do not count as crossing', () => {
    assert.equal(segmentsProperlyIntersect([0, 0], [10, 0], [0, 0], [0, 10]), false);
  });
  test('a T-junction (one endpoint lies exactly on the other segment) does not count as crossing', () => {
    // This is the exact configuration from the "third room on a shared wall"
    // bug: a new room's wall passes straight through the point where two
    // other rooms meet, with that point landing mid-edge, not at an endpoint.
    assert.equal(segmentsProperlyIntersect([250, 400], [675, 400], [475, 400], [475, 625]), false);
  });
  test('parallel, non-touching segments do not intersect', () => {
    assert.equal(segmentsProperlyIntersect([0, 0], [10, 0], [0, 5], [10, 5]), false);
  });
});

describe('polygonsOverlap — the contract: rooms may share a vertex or edge, never area', () => {
  test('two rooms sharing a full wall are NOT overlapping', () => {
    assert.equal(polygonsOverlap(rectA, rectAdjacentRight), false);
  });
  test('two rooms sharing only a single corner are NOT overlapping', () => {
    assert.equal(polygonsOverlap(rectA, rectSharedCorner), false);
  });
  test('a third room whose wall passes through a point shared by two other rooms (T-junction) is NOT overlapping', () => {
    const newRoom = [[250, 150], [675, 150], [675, 400], [250, 400]];
    const roomBelowLeft = [[100, 400], [475, 400], [475, 625], [100, 625]];
    const roomBelowRight = [[475, 400], [875, 400], [875, 625], [475, 625]];
    assert.equal(polygonsOverlap(newRoom, roomBelowLeft), false);
    assert.equal(polygonsOverlap(newRoom, roomBelowRight), false);
  });
  test('genuine partial (Venn-diagram) overlap IS detected', () => {
    assert.equal(polygonsOverlap(rectA, rectVennOverlap), true);
  });
  test('a vertex strictly inside another room IS detected', () => {
    assert.equal(polygonsOverlap(rectA, rectVertexInsideA), true);
  });
  test('an exact full duplicate IS detected, even though every vertex sits exactly on the other\'s boundary', () => {
    // This is the "drag a room to fully overlap another" bug: vertex- and
    // edge-based checks both legitimately ignore boundary-only contact,
    // so a perfect duplicate needs the centroid/midpoint sampling check.
    assert.equal(polygonsOverlap(rectA, rectFullDuplicate), true);
  });
  test('an edge cutting through the interior via boundary-touching corners IS detected', () => {
    assert.equal(polygonsOverlap(rectA, rectCutsThroughViaBoundaryCorners), true);
  });
});

describe('anyOverlap — same contract, exercised through the floor/room/vertex data model', () => {
  function makeFloor(roomDefs) {
    // roomDefs: { roomId: [[x,y], ...] }, vertex ids are derived from a
    // coordinate key so identical points automatically become the SAME
    // shared vertex (mirroring what the app's weld-on-drag does).
    const vertices = {};
    const vidFor = (x, y) => {
      const key = `${x},${y}`;
      if (!vertices[key]) vertices[key] = { x, y };
      return key;
    };
    const rooms = Object.entries(roomDefs).map(([id, points]) => ({
      id,
      name: id,
      color: '#fff',
      entities: [],
      vertexIds: points.map(([x, y]) => vidFor(x, y)),
    }));
    return { id: 'floor-1', name: 'Floor', vertices, rooms };
  }

  test('dragging a room to fully duplicate another is rejected', () => {
    // Deliberately NOT using the coordinate-welding makeFloor() helper here:
    // room A and room B start as genuinely independent rooms (as they would
    // after being drawn separately, before any drag), so moving B's vertices
    // must not also move A's.
    const vertices = {};
    rectA.forEach(([x, y], i) => { vertices[`A${i}`] = { x, y }; });
    rectAdjacentRight.forEach(([x, y], i) => { vertices[`B${i}`] = { x, y }; });
    const floor = {
      id: 'floor-1',
      vertices,
      rooms: [
        { id: 'A', name: 'A', color: '#fff', entities: [], vertexIds: ['A0', 'A1', 'A2', 'A3'] },
        { id: 'B', name: 'B', color: '#fff', entities: [], vertexIds: ['B0', 'B1', 'B2', 'B3'] },
      ],
    };
    // simulate B being dragged directly on top of A
    ['B0', 'B1', 'B2', 'B3'].forEach((vid, i) => {
      const [x, y] = rectA[i];
      floor.vertices[vid] = { x, y };
    });
    assert.equal(anyOverlap(floor, ['B']), true);
  });

  test('two rooms sharing a wall from the start pass cleanly', () => {
    const floor = makeFloor({ A: rectA, B: rectAdjacentRight });
    assert.equal(anyOverlap(floor, ['A', 'B']), false);
  });
});

describe('orient', () => {
  test('collinear points return 0', () => {
    assert.equal(orient([0, 0], [1, 0], [2, 0]), 0);
  });
  test('clockwise vs counter-clockwise return different non-zero values', () => {
    const cw = orient([0, 0], [1, 0], [1, 1]);
    const ccw = orient([0, 0], [1, 0], [1, -1]);
    assert.notEqual(cw, 0);
    assert.notEqual(ccw, 0);
    assert.notEqual(cw, ccw);
  });
});
