// Headless smoke test: build must exist (npm run build). Serves dist, plays the machine for a few seconds,
// and fails on console errors or if nothing moves. Saves screenshots to the directory given as argv[2].
import { chromium } from 'playwright';
import { preview } from 'vite';

const outDir = process.argv[2] ?? '.';
const server = await preview({ preview: { port: 4179, strictPort: true }, base: '/Plinkworks/' });
const url = 'http://localhost:4179/Plinkworks/';
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errors = [];
let failed = false;
for (const [name, viewport, touch] of [['phone', { width: 390, height: 844 }, true], ['desktop', { width: 1400, height: 900 }, false]]) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(url);
  await page.waitForSelector('#start:not([hidden])');
  await page.click('#start');
  await page.waitForTimeout(5000);
  const state = await page.evaluate(() => {
    const a = window.plinkworks;
    return { beat: a.sim.beat, balls: a.sim.balls.length, playing: a.playing, ctx: a.engine.currentTime };
  });
  console.log(name, JSON.stringify(state));
  if (!state.playing || state.beat < 2 || state.balls < 1) failed = true;
  await page.screenshot({ path: `${outDir}/smoke-${name}.png` });
  if (name === 'phone') {
    await page.click('#drawer-handle');
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${outDir}/smoke-${name}-drawer.png` });
    await page.click('#drawer-handle');
    await page.waitForTimeout(400);
    // Long-press the bumper to open its settings.
    const pos = await page.evaluate(() => {
      const a = window.plinkworks;
      const p = a.machine.parts.find((q) => q.type === 'bumper');
      const r = a.renderer.canvas.getBoundingClientRect();
      return { x: r.left + a.renderer.view.sx(p.x), y: r.top + a.renderer.view.sy(p.y) };
    });
    await page.mouse.move(pos.x, pos.y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const sheetOpen = await page.evaluate(() => !document.querySelector('#sheet').hidden);
    console.log('long-press opens settings:', sheetOpen);
    if (!sheetOpen) failed = true;
    await page.screenshot({ path: `${outDir}/smoke-${name}-settings.png` });
  }
  await ctx.close();
}
await browser.close();
server.httpServer.close();
if (errors.length) { console.error(errors.join('\n')); failed = true; }
process.exit(failed ? 1 : 0);
