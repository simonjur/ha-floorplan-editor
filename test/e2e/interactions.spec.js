// Interaction/DOM-level regression tests. These exist specifically for bugs
// that unit-testing geometry.js can't catch, because the bug was in how
// mouse/touch events interact with re-rendering, not in the geometry math
// itself. See SPEC.md for the underlying gotchas each of these guards.

import { test, expect } from '@playwright/test';

function canvasPoint(rect, x, y) {
  return [rect.left + x, rect.top + y];
}

async function canvasRect(page) {
  return page.$eval('#canvas', el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
}

test('floor tabs and room list remain clickable after a canvas drag causes a re-render', async ({ page }) => {
  // Regression: window's pointerup handler used to call render() on every
  // pointerup anywhere on the page, including a plain click on a button.
  // render() tears down and rebuilds those DOM elements, so the browser
  // cancelled the native click before its handler ran. Only reconcile on
  // pointerup when something was actually being dragged.
  await page.goto('/index.html');
  const rect = await canvasRect(page);

  await page.click('#btn-draw');
  await page.mouse.click(...canvasPoint(rect, 100, 100));
  await page.mouse.click(...canvasPoint(rect, 250, 100));
  await page.mouse.click(...canvasPoint(rect, 250, 200));
  await page.mouse.click(...canvasPoint(rect, 100, 200));
  await page.mouse.click(...canvasPoint(rect, 100, 100)); // close

  await page.click('#add-floor');
  const tabs = await page.$$('#floor-tabs .floor-tab');
  await tabs[0].click();
  await expect(page.locator('.floor-tab.active')).toHaveText('Ground Floor');

  const items = await page.$$('#room-list li');
  await items[0].click();
  await expect(page.locator('#inspector input[type=text]')).toHaveValue(/Room/);
});

test('a touch tap does not draw a phantom line from a stale (0,0) position', async ({ page }) => {
  // Regression: mousePos defaulted to (0,0) and was only updated by
  // pointermove. A touch tap fires pointerdown -> pointerup with no
  // preceding pointermove, so the very first point's preview line was
  // drawn from (0,0) instead of the tapped location.
  await page.goto('/index.html');
  const rect = await canvasRect(page);

  await page.tap('#btn-draw');
  await page.touchscreen.tap(rect.left + 150, rect.top + 150);

  const points = await page.locator('.draft-line').getAttribute('points');
  const coords = points.trim().split(/\s+/).map(pair => pair.split(',').map(Number));
  for (const [x, y] of coords) {
    expect(x).toBeGreaterThan(100);
    expect(y).toBeGreaterThan(100);
  }
});

test('drawing a room adjacent to two others is not rejected as an overlap', async ({ page }) => {
  // End-to-end version of the T-junction geometry test — exercised through
  // real clicks so a regression in event handling (not just the geometry
  // function) would also be caught here.
  await page.goto('/index.html');
  const rect = await canvasRect(page);
  const click = (x, y) => page.mouse.click(...canvasPoint(rect, x, y));

  await page.click('#btn-draw');
  for (const [x, y] of [[100, 400], [475, 400], [475, 625], [100, 625], [100, 400]]) await click(x, y);
  await page.click('#btn-draw');
  for (const [x, y] of [[475, 400], [875, 400], [875, 625], [475, 625], [475, 400]]) await click(x, y);
  await page.click('#btn-draw');
  for (const [x, y] of [[250, 150], [675, 150], [675, 400], [250, 400], [250, 150]]) await click(x, y);

  await expect(page.locator('#canvas polygon')).toHaveCount(3);
});
