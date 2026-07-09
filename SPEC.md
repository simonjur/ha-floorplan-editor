# Floor Plan Editor — Spec

This is the plain-language contract the code is supposed to uphold. When a
new feature or bugfix touches geometry, snapping, or dragging, check it
against this list — and if you find a case this doesn't cover, add it here
*and* as a test, in that order. A bug that isn't written down here as a
rule will come back.

## Module structure

```
src/geometry.js        pure math — polygon overlap, point-in-polygon, etc.
                       zero DOM dependency. Unit-tested in test/geometry.test.js.

src/interactions.js    the actual decisions in response to input — snapping,
                       "can this room be placed", drag-with-overlap-revert,
                       zoom math. Mutates the floor/view objects it's given,
                       but touches no DOM. Unit-tested in test/interactions.test.js.

src/render.js          builds/updates the DOM (SVG elements, lists) from
                       plain state. Takes handler callbacks for interaction
                       (onRoomPointerDown, onSelectRoom, ...) rather than
                       deciding anything itself. Tested with jsdom in
                       test/render.test.js — DOM structure only, not real
                       layout (jsdom doesn't compute that; see test/e2e/
                       for pixel/browser-accurate behavior).

src/index.html          standalone full-page app shell — dev/testing only,
                       not what ships to Home Assistant. Wires interactions.js
                       + render.js together for a browser tab. Kept around
                       because it's the fastest loop for iterating on
                       geometry/interaction changes without an HA instance.

src/floorplan-card.js   the actual Home Assistant Lovelace card — a custom
                       element implementing setConfig/hass/getCardSize,
                       rendering into its own shadow DOM. Same orchestration
                       role as index.html, just re-hosted as a component
                       that lives inside someone else's page instead of
                       owning the whole page. Not unit-tested directly (it's
                       wiring, like index.html); covered by loading it as a
                       real custom element in a browser — see
                       dev/card-harness.html and README's "Testing the card
                       without Home Assistant".
```

The rule of thumb for "which file does this go in": if a function's
correctness could be checked with a plain assertion on its return value
(no DOM, no rendering), it belongs in `geometry.js` or `interactions.js`.
If it has to build or inspect actual DOM nodes, it belongs in `render.js`.
If it's wiring — reading a checkbox, calling `.focus()`, deciding which
function to call next, or anything that only makes sense once you know
whether you're running standalone or inside HA — it stays in
`index.html`/`floorplan-card.js` respectively, and doesn't need its own
unit tests as long as the modules it calls into are covered.

## Persistence

`floorplan-card.js` currently stores the floor plan in the **dashboard's
own config** (the same YAML/storage Lovelace already keeps card configs
in): `setConfig({ floors })` reads it in, and every edit calls `_persist()`,
which dispatches a `config-changed` event — the standard mechanism Lovelace
listens for on any card to write an updated config back.

This is deliberately the simplest thing that works, not the final design.
Its limits:
- The floor plan lives and dies with one specific card on one specific
  dashboard. Viewing or editing it from a second dashboard means a second,
  independent copy.
- No multi-user conflict handling — last save wins.

The alternative is a proper `custom_components/floorplan_editor` backend
integration using HA's `Store()` helper and websocket commands, giving
every dashboard/user a shared, single source of truth. That's a real
architecture decision, not just more code — `Store()` + a websocket API in
Python, vs. the `config-changed` event you already have wired up
correctly. Move to it when/if "the plan needs to be visible or editable
from more than one place" actually becomes true, not preemptively.

## Data model

- Rooms don't store raw coordinates. Each floor has a `vertices` map
  (`{ [id]: {x, y} }`), and a room is just an ordered list of vertex IDs
  into that map.
- Two rooms sharing a wall or corner reference the **same vertex ID** —
  they aren't two coincidentally-equal points, they're the same point.
  This is what makes "resize a wall and everything connected to it moves
  too" work without any special-case code: a wall's length is never
  stored, only ever computed live from its two endpoints.

## Overlap rules

Two rooms may share a **vertex**, a **full edge**, or **part of an edge**.
None of that counts as overlapping. Any positive-area intersection of
their interiors does.

This needs three independent checks (`polygonsOverlap` in `geometry.js`),
because each one alone has a blind spot the others cover:

1. **Vertex containment** — a corner of one room strictly inside the
   other. Catches most ordinary partial overlaps.
2. **Edge crossing** — a genuine transversal ("X") crossing between an
   edge of each room. Catches overlaps where no single vertex happens to
   land inside the other room.
   - A **shared endpoint** is not a crossing.
   - A **T-junction** — one edge's endpoint lying exactly on the middle of
     the other edge, e.g. a new room's wall passing through the exact
     point where two other rooms meet — is not a crossing either. Both of
     these are legitimate contact.
3. **Centroid/midpoint sampling** — checks 1 and 2 both intentionally
   treat boundary-only contact as "not overlapping" (required for #1/#2
   above to work at all). The blind spot that creates: if a room gets
   dragged to exactly duplicate or fully sit inside another, *every*
   vertex can end up sitting exactly on the other's boundary and every
   edge exactly collinear with it — neither check can tell that apart
   from simple touching. Sampling each polygon's centroid and edge
   midpoints against the other catches this: a real overlap always has
   points strictly inside the other polygon; legitimate sharing never
   does.

If you ever find a configuration where two rooms visibly overlap in the
UI but `polygonsOverlap` returns `false` (or the reverse — legitimate
sharing gets rejected), that's a bug in one of these three checks, not a
missing fourth one. Start by writing the failing case as a test.

## Wall length editing

- Editing a wall's length moves **one endpoint only** (the second vertex
  of that edge; the first is the anchor). This is a deliberate, if
  arbitrary, convention — not a bug — and it's what's currently
  documented. Flip it only with a UI affordance to choose which end
  anchors, not silently.
- If the moving endpoint is shared with other rooms/walls, those walls
  resize too, automatically — see "Data model" above for why.
- A length edit that would cause an overlap is rejected the same way a
  drag is: the vertex snaps back and the edit doesn't apply.

## Snapping

- Vertex dragging snaps to: the grid, alignment with other vertices
  (axis guides), and welding onto an existing vertex within a screen-pixel
  threshold.
- All snap thresholds are screen-pixel distances converted to world units
  via the current zoom level (`threshold / view.zoom`), not fixed world
  distances — otherwise snapping feels too loose zoomed out and too tight
  zoomed in.
- Whole-room dragging only grid-snaps; it does not weld to other rooms'
  vertices. (Scoping decision, not a limitation anyone's hit yet — revisit
  if it becomes annoying in practice.)

## Coordinate systems

- Room geometry (vertices, `drawingPoints`, `mousePos`) is always in
  **world space** and never changes when you pan or zoom.
- `view.panX/panY/zoom` is the only thing pan/zoom touches. Screen ↔ world
  conversion happens at `worldFromScreen` / `screenFromWorld`, used at the
  point where a mouse/touch/wheel event comes in or a DOM element (like
  the length-edit `<input>`) needs absolute positioning.
- Never compare a raw (unsnapped) screen/world point against an
  already-snapped stored point directly in world units — grid-snap
  rounding plus zoom scaling can make that gap larger than a screen-pixel
  threshold expects. Project both to the same space (usually screen) before
  comparing distances. This is exactly what broke "click near your first
  point to close the shape" at non-1x zoom.

## Rendering / DOM interaction gotcha

`window.addEventListener("pointerup", ...)` must not unconditionally
re-render. `render()` tears down and rebuilds DOM elements (floor tabs,
room list items, measurement labels); if it runs *between* a native
mousedown and the mouseup that would fire `click` on one of those
elements, the browser cancels that `click` entirely because its target
got replaced mid-gesture. Only reconcile on pointerup when something was
actually being dragged (`if (!dragging) return;`).

## Removing a focused DOM element from within its own event handler

Calling `.remove()` on a focused `<input>` fires that input's own `blur`
event synchronously. If both a keydown handler and the blur handler call
the same "commit" function, guard it with a `settled` flag so it only
runs once — otherwise the second call operates on an already-detached
node and throws.

## Mobile

- Touch has no hover: `pointermove` never fires before the first
  `pointerdown` of a drawing gesture, so anything relying on a
  previously-tracked mouse position (e.g. a live preview line to the
  cursor) must be initialized to the just-placed point on pointerdown, not
  left at a stale default.
- The canvas needs `touch-action: none` or touch drawing/dragging fights
  the browser's native scroll/pinch-zoom gestures.

## Open questions / known gaps

These surfaced while extracting and testing `interactions.js` — they're
existing behavior, not new bugs from that refactor, but they weren't
written down anywhere before and are worth a deliberate decision rather
than being silently "fixed" or "left broken" by whoever touches this code
next.

- **Dragging a whole room that shares a wall with a neighbor also drags
  the neighbor's shared corner.** Because shared vertices are the same
  object (see "Data model"), translating room B by its body — not a
  vertex — moves every vertex in `B.vertexIds`, including ones also
  referenced by room A. There's currently no "detach on drag" step that
  would give B its own independent copy of a shared corner the moment a
  whole-room drag begins. Whether rooms should cleanly separate on
  whole-room drag, or dragging a wall-sharing room should always warp its
  neighbor along with it, is a real product decision — see
  `test/interactions.test.js`, the test named "dragging a room that
  shares a wall with another also moves the shared corner", for the
  current behavior pinned down as a test rather than a bug.
- **`invalidRoomIds` (the mechanism for highlighting an overlapping room
  red mid-drag) is always empty.** `render.js` has a `.room-polygon.invalid`
  class ready to use, but nothing in `index.html` ever actually populates
  the set — the two branches that used to set it (overlap vs. no overlap)
  both unconditionally reset it to empty. Cosmetic only; drag-reject
  behavior itself is unaffected. Wire it up if the red-flash-while-dragging
  feedback turns out to matter in practice.
