// Tests for src/render.js using jsdom — these check the DOM structure
// render.js produces (element counts, classes, attributes, that handlers
// get wired up and fire with the right arguments), not real layout or
// pixel positions, which jsdom doesn't compute anyway. Pixel-accurate
// behavior (e.g. "the room actually appears where I clicked") is covered
// by the Playwright e2e suite in test/e2e/, which runs in a real browser.
//
// Globals (document, window) must be set up BEFORE importing render.js,
// but ES module imports are hoisted above other top-level statements — the
// import itself is fine to appear first textually, because render.js only
// touches `document` inside its exported functions, not at module-load
// time. Those functions aren't called until after setup() below runs.

import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let renderCanvas, renderRoomList, renderFloorTabs, renderInspector, renderMeasurementLabel, el;

before(async () => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  global.window = dom.window;
  global.document = dom.window.document;
  // jsdom doesn't compute real layout — getBoundingClientRect always
  // returns zeros. renderGrid divides by that; give it a plausible size so
  // grid-line generation has something to iterate over where a test cares.
  dom.window.SVGElement.prototype.getBoundingClientRect = () => ({ width: 800, height: 600, top: 0, left: 0 });

  const mod = await import('../src/render.js');
  ({ renderCanvas, renderRoomList, renderFloorTabs, renderInspector, renderMeasurementLabel, el } = mod);
});

function makeFloor(roomDefs = {}) {
  const vertices = {};
  const vidFor = (x, y) => {
    const key = `${x},${y}`;
    if (!vertices[key]) vertices[key] = { x, y };
    return key;
  };
  const rooms = Object.entries(roomDefs).map(([id, points]) => ({
    id, name: id, color: '#5b8def', entities: [],
    vertexIds: points.map(([x, y]) => vidFor(x, y)),
  }));
  return { id: 'floor-1', name: 'Floor', vertices, rooms };
}

const rectA = [[100, 100], [300, 100], [300, 220], [100, 220]];
const rectB = [[400, 100], [600, 100], [600, 220], [400, 220]];

const noopHandlers = {
  onRoomPointerDown: () => {},
  onVertexPointerDown: () => {},
  onMeasurementEdit: () => {},
  onSelectRoom: () => {},
  onSelectFloor: () => {},
  onRename: () => {},
  onDelete: () => {},
};

function baseAppState(overrides = {}) {
  return {
    floor: makeFloor({ A: rectA }),
    selectedRoomId: null,
    invalidRoomIds: new Set(),
    guides: [],
    mode: 'select',
    drawingPoints: [],
    mousePos: { x: 0, y: 0 },
    view: { panX: 0, panY: 0, zoom: 1 },
    showMeasurements: false,
    ...overrides,
  };
}

describe('renderCanvas', () => {
  let svg;
  beforeEach(() => {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  });

  test('renders one polygon per room', () => {
    const state = baseAppState({ floor: makeFloor({ A: rectA, B: rectB }) });
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.equal(svg.querySelectorAll('polygon.room-polygon').length, 2);
  });

  test('vertex handles only appear for the selected room', () => {
    const floor = makeFloor({ A: rectA, B: rectB });
    const state = baseAppState({ floor, selectedRoomId: 'A' });
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.equal(svg.querySelectorAll('circle.vertex-handle').length, 4); // A's 4 corners only
  });

  test('no vertex handles when nothing is selected', () => {
    const state = baseAppState({ floor: makeFloor({ A: rectA }), selectedRoomId: null });
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.equal(svg.querySelectorAll('circle.vertex-handle').length, 0);
  });

  test('an invalid (overlapping, mid-drag) room gets the invalid class', () => {
    const floor = makeFloor({ A: rectA });
    const state = baseAppState({ floor, invalidRoomIds: new Set(['A']) });
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.ok(svg.querySelector('polygon.room-polygon.invalid'));
  });

  test('measurement labels appear only when showMeasurements is true', () => {
    const floor = makeFloor({ A: rectA });
    const shown = baseAppState({ floor, showMeasurements: true });
    const hidden = baseAppState({ floor, showMeasurements: false });
    renderCanvas(svg, shown, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.equal(svg.querySelectorAll('.measure-hit').length, 4); // one per wall of a 4-sided room
    renderCanvas(svg, hidden, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.equal(svg.querySelectorAll('.measure-hit').length, 0);
  });

  test('clicking a room polygon calls onRoomPointerDown with that room', () => {
    const floor = makeFloor({ A: rectA });
    const state = baseAppState({ floor });
    let received = null;
    const handlers = { ...noopHandlers, onRoomPointerDown: (e, room) => { received = room; } };
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), handlers);
    const poly = svg.querySelector('polygon.room-polygon');
    poly.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    assert.equal(received.id, 'A');
  });

  test('a draft polygon-in-progress renders a draft line and points', () => {
    const state = baseAppState({
      mode: 'draw',
      drawingPoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
      mousePos: { x: 50, y: 150 },
      floor: makeFloor(),
    });
    renderCanvas(svg, state, 25, (px) => (px / 50).toFixed(2), noopHandlers);
    assert.ok(svg.querySelector('.draft-line'));
    assert.equal(svg.querySelectorAll('.draft-point').length, 3);
    assert.ok(svg.querySelector('.draft-point.first'));
  });
});

describe('renderRoomList', () => {
  let ul;
  beforeEach(() => { ul = document.createElement('ul'); });

  test('shows an empty-state message when there are no rooms', () => {
    renderRoomList(ul, makeFloor(), null, noopHandlers);
    assert.match(ul.textContent, /No rooms yet/);
  });

  test('renders one item per room and marks the selected one', () => {
    const floor = makeFloor({ A: rectA, B: rectB });
    renderRoomList(ul, floor, 'B', noopHandlers);
    const items = ul.querySelectorAll('li');
    assert.equal(items.length, 2);
    const selected = [...items].filter((li) => li.className === 'selected');
    assert.equal(selected.length, 1);
    assert.match(selected[0].textContent, /B/);
  });

  test('clicking an item calls onSelectRoom with that room\'s id', () => {
    const floor = makeFloor({ A: rectA });
    let selectedId = null;
    renderRoomList(ul, floor, null, { onSelectRoom: (id) => { selectedId = id; } });
    ul.querySelector('li').click();
    assert.equal(selectedId, 'A');
  });
});

describe('renderFloorTabs', () => {
  test('renders one tab per floor, marking the current one active', () => {
    const tabsEl = document.createElement('div');
    const floors = [{ id: 'f1', name: 'Ground' }, { id: 'f2', name: 'First' }];
    renderFloorTabs(tabsEl, floors, 'f2', noopHandlers);
    const buttons = tabsEl.querySelectorAll('button');
    assert.equal(buttons.length, 2);
    assert.ok(buttons[1].className.includes('active'));
    assert.ok(!buttons[0].className.includes('active'));
  });

  test('clicking a tab calls onSelectFloor with that floor\'s id', () => {
    const tabsEl = document.createElement('div');
    const floors = [{ id: 'f1', name: 'Ground' }];
    let selected = null;
    renderFloorTabs(tabsEl, floors, 'f1', { onSelectFloor: (id) => { selected = id; } });
    tabsEl.querySelector('button').click();
    assert.equal(selected, 'f1');
  });
});

describe('renderInspector', () => {
  test('shows a placeholder when no room is selected', () => {
    const inspectorEl = document.createElement('div');
    renderInspector(inspectorEl, null, noopHandlers);
    assert.match(inspectorEl.textContent, /Select a room/);
  });

  test('shows the room name and corner count when a room is selected', () => {
    const inspectorEl = document.createElement('div');
    const room = { id: 'A', name: 'Kitchen', vertexIds: ['a', 'b', 'c', 'd'] };
    renderInspector(inspectorEl, room, noopHandlers);
    assert.equal(inspectorEl.querySelector('#room-name-input').value, 'Kitchen');
    assert.match(inspectorEl.textContent, /Corners: 4/);
  });

  test('editing the name input calls onRename', () => {
    const inspectorEl = document.createElement('div');
    const room = { id: 'A', name: 'Kitchen', vertexIds: [] };
    let newName = null;
    renderInspector(inspectorEl, room, { ...noopHandlers, onRename: (n) => { newName = n; } });
    const input = inspectorEl.querySelector('#room-name-input');
    input.value = 'Living Room';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(newName, 'Living Room');
  });

  test('clicking delete calls onDelete', () => {
    const inspectorEl = document.createElement('div');
    const room = { id: 'A', name: 'Kitchen', vertexIds: [] };
    let deleted = false;
    renderInspector(inspectorEl, room, { ...noopHandlers, onDelete: () => { deleted = true; } });
    inspectorEl.querySelector('#btn-delete-room').click();
    assert.equal(deleted, true);
  });
});

describe('renderMeasurementLabel', () => {
  test('renders nothing for a degenerate (near-zero-length) edge', () => {
    const floor = makeFloor({ A: rectA });
    const vids = Object.keys(floor.vertices);
    const parent = el('g');
    const result = renderMeasurementLabel(parent, floor, { a: vids[0], b: vids[0], roomIds: ['A'] }, (px) => px.toFixed(2), () => {});
    assert.equal(result, null);
    assert.equal(parent.children.length, 0);
  });

  test('clicking the label calls onEdit with the edge and computed length', () => {
    const floor = makeFloor({ A: rectA });
    const vids = Object.keys(floor.vertices);
    const aVid = vids.find((v) => floor.vertices[v].x === 100 && floor.vertices[v].y === 100);
    const bVid = vids.find((v) => floor.vertices[v].x === 300 && floor.vertices[v].y === 100);
    const parent = el('g');
    let editedLen = null;
    renderMeasurementLabel(parent, floor, { a: aVid, b: bVid, roomIds: ['A'] }, (px) => (px / 50).toFixed(2), (edge, lx, ly, len) => { editedLen = len; });
    parent.querySelector('.measure-hit').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(editedLen, 200); // (100,100)-(300,100) is 200 world units
  });
});
