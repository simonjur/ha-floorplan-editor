# Floor Plan Editor (prototype)

In-browser vector editor for drawing a Home Assistant floor plan: draw
rooms, snap walls to a grid and to each other, edit wall lengths, pan/zoom.
This is the standalone prototype stage — entity binding and the actual HA
custom card wrapper come next.

`SPEC.md` documents the behavioral contract (especially the overlap rules,
which are subtler than they look) and the module structure — read it
before adding to `src/`.

```
src/geometry.js        pure math (polygon overlap, etc.) — test/geometry.test.js
src/interactions.js    decision logic (snapping, drag, zoom) — test/interactions.test.js
src/render.js          DOM building — test/render.test.js (jsdom)
src/index.html         thin app shell wiring the above together
test/e2e/               Playwright — DOM/event-timing bugs the above can't see
```

## Running it

```
npm install
npm run dev     # serves src/ at http://localhost:8934
```

Open `http://localhost:8934/index.html`. It has to be served over HTTP, not
opened as a `file://` — the app imports `geometry.js` as an ES module, and
browsers block module imports from the filesystem.

## Tests

```
npm test          # geometry + interactions unit tests (Node's built-in runner, no browser)
npm run test:e2e   # DOM/interaction tests via Playwright (first run: npx playwright install chromium)
```

`npm test` covers geometry, snapping/drag decisions, and DOM-building
structure (via jsdom) — it's your first check on any change, runs in under
two seconds, and needs no real browser. (It runs `node --test
test/*.test.js` rather than bare `node --test`, because Node's default
recursive discovery also matches `*.spec.js` and will sweep up — and crash
on — the Playwright e2e spec, which uses a different, incompatible `test`
API.)
`npm run test:e2e` covers things that are specifically about real-browser
DOM/event timing (a click getting cancelled by a mid-gesture re-render, a
touch tap with no preceding hover, actual pixel layout) that jsdom doesn't
simulate.

## Before adding a new feature

1. Read `SPEC.md`.
2. If the feature touches overlap, snapping, dragging, or coordinates,
   check whether an existing test already covers the boundary you're
   about to change.
3. Run `npm test` (and `npm run test:e2e` if you're touching interaction
   code, not just geometry) before and after.
4. If you fix a bug, add the failing case as a test in the same commit —
   not as a follow-up. Every bug in `SPEC.md`'s history started as a
   one-off Playwright script that got deleted after the fix; the point of
   this repo is to stop doing that.

## Suggested next step

Wire `npm test` into GitLab CI (or wherever this ends up living) as a
required check on merge requests — two-line `.gitlab-ci.yml` job running
`npm ci && npm test`. `npm run test:e2e` is heavier (needs a browser) and
is a reasonable candidate for a slower/separate CI stage rather than
blocking every push.
