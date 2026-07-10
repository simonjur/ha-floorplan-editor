# Floor Plan Editor (prototype)

In-browser vector editor for drawing a Home Assistant floor plan: draw
rooms, snap walls to a grid and to each other, edit wall lengths, pan/zoom.
Entity binding / live state overlay is the next step, not yet built.

`SPEC.md` documents the behavioral contract (especially the overlap rules,
which are subtler than they look) and the module structure — read it
before adding to `src/`.

```
src/geometry.js        pure math (polygon overlap, etc.) — test/geometry.test.js
src/interactions.js    decision logic (snapping, drag, zoom) — test/interactions.test.js
src/render.js          DOM building — test/render.test.js (jsdom)
src/index.html         standalone full-page dev harness (not shipped to HA)
src/floorplan-card.js  the actual HA Lovelace card (custom element)
test/e2e/               Playwright — DOM/event-timing bugs the above can't see
dev/card-harness.html   loads floorplan-card.js as HA would, without HA
```

## Running the standalone dev version

```
npm install
npm run dev     # serves src/ at http://localhost:8934
```

Open `http://localhost:8934/index.html`. This is the fastest loop for
iterating on geometry/snapping/drag logic — full page, no HA needed. It
has to be served over HTTP, not opened as `file://`, since it imports
`geometry.js` etc. as ES modules and browsers block that from the
filesystem.

## Testing the card without Home Assistant

`floorplan-card.js` is a real custom element (`<floorplan-card>`), so you
can load and drive it in a plain browser tab before ever touching an HA
instance:

```
npm run dev:card   # serves the repo root at http://localhost:8935
```

Open `http://localhost:8935/dev/card-harness.html`. It registers the
element, calls `setConfig({})` and sets a stub `hass`, exactly like
Lovelace would — everything (drawing, dragging, zoom, the `config-changed`
persistence event) works the same as inside real HA.

## Installing it in Home Assistant

1. **Build the single-file bundle** — HA loads one JS file as a Lovelace
   resource; it doesn't resolve the multi-file ES module imports `src/`
   uses for dev convenience.
   ```
   npm run build   # -> dist/floorplan-card.js
   ```
2. **Copy it into your HA config's `www/` folder** (create the folder if
   it doesn't exist — anything under `config/www/` is served at `/local/`):
   ```
   cp dist/floorplan-card.js /path/to/homeassistant/config/www/floorplan-card.js
   ```
3. **Register it as a Lovelace resource** — Settings → Dashboards → ⋮ menu
   → Resources → Add Resource:
   - URL: `/local/floorplan-card.js`
   - Resource type: JavaScript Module

   (Or in YAML mode, under `lovelace.resources` /
   `configuration.yaml`: `- url: /local/floorplan-card.js` `  type: module`.)
4. **Add the card to a dashboard** — Edit Dashboard → Add Card → search
   won't find it since it's not registered with HA's card picker; instead
   add a **Manual** card with:
   ```yaml
   type: custom:floorplan-card
   ```
5. Draw a floor plan; edits save into that card's own dashboard config
   automatically (see `SPEC.md`, "Persistence" — this is card-config
   storage, not a backend integration, and that's a deliberate scope
   choice for now, not a limitation to work around).

**Iterating without re-copying by hand every time:** either symlink instead
of copying —
```
ln -s $(pwd)/dist/floorplan-card.js /path/to/homeassistant/config/www/floorplan-card.js
```
and re-run `npm run build` after each change — or, if HA is a separate
machine/container, script the copy as part of `npm run build` once you
know the target path. HA aggressively caches JS resources; after
rebuilding, a hard refresh (Ctrl+Shift+R) is usually necessary, and if
that's not enough, bump the resource URL's version query string
(`/local/floorplan-card.js?v=2`) in the resource config to force a refetch.

## Installing it via HACS (GitHub, auto-updating)

This is the no-manual-copy path for a real HA instance somewhere else on
your network (homelab, separate container, etc.): you push a version tag,
GitHub Actions builds `dist/floorplan-card.js` and attaches it to a
Release, and HACS on your HA pulls it. Updating later is one click in HACS
plus a browser refresh — you never touch the HA filesystem.

`dist/` is git-ignored and built in CI, so nothing built is ever committed.
The pieces that make this work already live in the repo:

- `.github/workflows/release.yml` — on a pushed `v*` tag, runs
  `npm ci && npm test && npm run build` and publishes a GitHub Release with
  `dist/floorplan-card.js` as an asset.
- `hacs.json` — tells HACS this repo is a Lovelace plugin and which file to
  fetch (`floorplan-card.js`).

### One-time setup on your HA instance

1. **Have [HACS](https://hacs.xyz) installed** (if not, follow its docs
   first — it's a one-time integration install).
2. **Add this repo as a custom repository** — HACS → ⋮ (top right) →
   *Custom repositories*:
   - Repository: `simonjur/ha-floorplan-editor`
   - Type: **Dashboard** (a.k.a. Lovelace/Plugin)
3. **Install it** — the card now shows up in HACS; open it and click
   *Download*. HACS downloads the release asset into `www/community/…` and,
   on current HA, registers the Lovelace resource for you automatically.
   (If your HA is in YAML/storage mode where HACS can't auto-register, add
   the resource once by hand — URL is whatever HACS shows on the card's
   page, type *JavaScript Module*.)
4. **Add the card to a dashboard** — same as step 4 above: a **Manual**
   card with `type: custom:floorplan-card`.

### The release loop (what you do from now on)

```
# make changes, commit, then:
npm version patch          # bumps package.json, creates the git tag
git push && git push --tags
```

Pushing the tag triggers the workflow; watch it under the repo's **Actions**
tab. When it finishes there's a new Release. In HACS the card then shows an
**Update available** badge — click *Update*, then hard-refresh the
dashboard (Ctrl+Shift+R; HACS bumps the resource's version query string, so
usually one refresh is enough). No SSH, no `cp`, no editing files on the HA
box.

(`npm version patch` is just a convenience — any `git tag vX.Y.Z &&
git push --tags` works. The tag name only has to start with `v` to match
the workflow trigger. The build fails the release if `npm test` fails, so a
broken bundle never ships.)

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
simulate. It currently drives `src/index.html`, not the card — the card's
own wiring is close enough to index.html's that this is reasonable
coverage for now, but if `floorplan-card.js` grows card-specific logic
(entity binding, hass-state handling), give it its own e2e spec rather
than assuming index.html's coverage still applies.

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
blocking every push. `npm run build` is cheap enough to also run in CI as
a "does the bundle still compile" smoke check, even before you're ready to
automate deployment to an actual HA instance.

