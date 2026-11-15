#!/usr/bin/env node
/**
 * Headless screenshot helper (software WebGL via SwiftShader).
 *
 *   node scripts/shot.mjs --url http://127.0.0.1:5173/?sandbox=ocean --out .shots/ocean.png
 *
 * Options:
 *   --url <url>          page to open (required)
 *   --out <file.png>     screenshot path (required; parent dirs are created)
 *   --width <px>         viewport width  (default 1280)
 *   --height <px>        viewport height (default 720)
 *   --mobile             emulate a phone (390x844 portrait unless --landscape, touch enabled)
 *   --landscape          with --mobile: 844x390
 *   --wait <ms>          extra wait after load/ready before the screenshot (default 2500)
 *   --ready <js>         JS expression polled until truthy before waiting (default: a <canvas> or #root child exists)
 *   --eval <js>          JS to run in the page after ready (before --wait). May be async.
 *   --hold <codes>       comma list of KeyboardEvent.code values to hold during --wait, e.g. KeyW,ArrowUp
 *   --press <codes>      comma list of keys to tap (after ready), e.g. KeyC,KeyT
 *   --click <selector>   click an element after ready (repeatable via comma)
 *   --console            print page console messages
 *   --timeout <ms>       overall navigation/ready timeout (default 120000)
 *
 * Prints page errors (uncaught exceptions) always; exits non-zero if the page threw.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.out) {
  console.error('usage: node scripts/shot.mjs --url <url> --out <file.png> [options]');
  process.exit(2);
}

export const GL_ARGS = [
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  '--enable-webgl',
  '--autoplay-policy=no-user-gesture-required',
];

const mobile = Boolean(args.mobile);
const landscape = Boolean(args.landscape);
const width = Number(args.width ?? (mobile ? (landscape ? 844 : 390) : 1280));
const height = Number(args.height ?? (mobile ? (landscape ? 390 : 844) : 720));
const wait = Number(args.wait ?? 2500);
const timeout = Number(args.timeout ?? 120000);

const browser = await chromium.launch({ args: GL_ARGS });
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  hasTouch: mobile,
  isMobile: mobile,
});
const page = await context.newPage();
let pageErrors = 0;
page.on('pageerror', (err) => {
  pageErrors++;
  console.error('[pageerror]', err.message);
});
page.on('console', (msg) => {
  if (args.console || msg.type() === 'error') console.log(`[console.${msg.type()}]`, msg.text());
});

try {
  await page.goto(String(args.url), { waitUntil: 'load', timeout });
  const ready =
    typeof args.ready === 'string'
      ? args.ready
      : "document.querySelector('canvas') || (document.getElementById('root') && document.getElementById('root').children.length > 0)";
  await page.waitForFunction(ready, undefined, { timeout });
  if (typeof args.eval === 'string') {
    await page.evaluate(`(async () => { ${args.eval} })()`);
  }
  if (typeof args.click === 'string') {
    for (const sel of args.click.split(',')) await page.click(sel.trim(), { timeout: 10000 });
  }
  if (typeof args.press === 'string') {
    for (const code of args.press.split(',')) await page.keyboard.press(code.trim());
  }
  const held = typeof args.hold === 'string' ? args.hold.split(',').map((s) => s.trim()) : [];
  for (const code of held) await page.keyboard.down(code);
  await page.waitForTimeout(wait);
  for (const code of held) await page.keyboard.up(code);
  const outPath = resolve(String(args.out));
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath });
  console.log(`saved ${outPath} (${width}x${height})`);
} catch (err) {
  console.error('[shot] failed:', err.message);
  pageErrors++;
} finally {
  await browser.close();
}
process.exit(pageErrors > 0 ? 1 : 0);
