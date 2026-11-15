// Opens the built app in real Chrome and Edge (on a Windows machine in GitHub Actions), tries the main screens and the
// PDF reader with a mouse and keyboard, and saves screenshots. Run: node ci/check.mjs <outdir>
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {extname, join} from 'node:path';

const out = process.argv[2] || 'shots';
await mkdir(out, {recursive: true});
const T = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff': 'font/woff', '.pdf': 'application/pdf'};
const srv = createServer(async (q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  try { r.writeHead(200, {'content-type': T[extname(p)] || 'application/octet-stream'}); r.end(await readFile(join('.', p))); } catch { r.writeHead(404); r.end(); }
}).listen(0);
const U = `http://localhost:${srv.address().port}`;
const lines = [`${process.platform} ${process.arch}, node ${process.version}`];
let failed = false;

for (const channel of (process.env.CHANNELS || 'chrome,msedge').split(',')) {
  const log = s => { lines.push(`[${channel}] ${s}`); console.log(`[${channel}] ${s}`); };
  let b;
  try { b = await chromium.launch(channel === 'chromium' ? {} : {channel}); } catch (e) { log('could not start: ' + String(e.message).split('\n')[0]); failed = true; continue; }
  log('version ' + b.version());
  for (const [w, h, tag] of [[1366, 768, 'laptop'], [1920, 1080, 'wide']]) {
    const ctx = await b.newContext({viewport: {width: w, height: h}}), p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
    const shot = n => p.screenshot({path: join(out, `${channel}-${tag}-${n}.png`)});
    const step = async (name, f) => { try { const v = await f(); log(`${tag} ${name}: ${v ?? 'ok'}`); } catch (e) { failed = true; log(`${tag} ${name}: FAILED ${String(e.message).split('\n')[0]}`); } };
    await p.addInitScript(() => {
      if (localStorage.getItem('seeded')) return; localStorage.setItem('seeded', '1');
      localStorage.setItem('mic.db.library', JSON.stringify({version: 1, records: [{id: 'ex1', kind: 'pdf', title: 'Sample lecture', unit: '', level: '', tags: [], note: '', fileName: 'sample.pdf', path: 'library/ex1.pdf', size: 1, mime: 'application/pdf', createdAt: 1, updatedAt: 1}]}));
      localStorage.setItem('mic.db.topics', JSON.stringify({version: 1, records: [{id: 'tp1', title: 'Postpartum haemorrhage', unit: '', level: '', tags: [], materials: ['ex1'], notes: '<h2>Causes</h2><p>Tone, trauma, tissue, thrombin.</p>', createdAt: 1, updatedAt: 1}]}));
    });
    await step('opens', async () => { await p.goto(U + '/app/#/today'); await p.waitForSelector('#view h2, #view h1, #view .sheet', {timeout: 20000}); return await p.title(); });
    await p.evaluate(async u => {
      const blob = await (await fetch(u)).blob();
      const db = await new Promise(ok => { const r = indexedDB.open('mic-files', 1); r.onupgradeneeded = () => r.result.createObjectStore('f'); r.onsuccess = () => ok(r.result); });
      await new Promise(ok => { const tx = db.transaction('f', 'readwrite'); tx.objectStore('f').put(blob, 'library/ex1.pdf'); tx.oncomplete = ok; });
    }, U + '/ci/sample.pdf');
    for (const r of ['today', 'library', 'topics', 'review', 'settings']) await step('screen ' + r, async () => { await p.goto(U + '/app/#/' + r); await p.waitForTimeout(700); await shot(r); });
    await step('study: pdf pages', async () => { await p.goto(U + '/app/#/study/tp1'); await p.waitForSelector('.pg .pgc', {timeout: 30000}); await p.waitForTimeout(2500); await shot('study'); return (await p.$$('.pg')).length + ' pages'; });
    const rb = await (await p.$('#rd')).boundingBox();
    const z = () => p.evaluate(() => document.querySelector('#rd .pg').offsetWidth);
    await step('text layer', async () => { const n = await p.evaluate(() => document.querySelectorAll('#rd .textLayer span').length); if (!n) throw new Error('no selectable text'); return n + ' spans'; });
    await step('ctrl+wheel zoom', async () => { const a = await z(); await p.mouse.move(rb.x + rb.width / 2, rb.y + 300); await p.keyboard.down('Control'); await p.mouse.wheel(0, -300); await p.keyboard.up('Control'); await p.waitForTimeout(1200); const c = await z(); if (c <= a) throw new Error(`${a} -> ${c}`); return `${a} -> ${c} px`; });
    await step('ctrl+f search', async () => { await p.keyboard.press('Control+f'); await p.waitForSelector('#fq', {timeout: 5000}); await p.fill('#fq', 'the'); await p.waitForTimeout(1500); const n = await p.$$eval('.findlist li', l => l.length); await shot('search'); await p.keyboard.press('Escape'); await p.waitForTimeout(400); return n + ' results'; });
    await step('pen with the mouse', async () => { if (await p.$('.tools[data-collapsed]')) await p.click('.tools .tcur'); await p.click('[data-tool="pen"]'); await p.mouse.move(rb.x + 200, rb.y + 250); await p.mouse.down(); for (let i = 0; i < 20; i++) await p.mouse.move(rb.x + 200 + i * 8, rb.y + 250 + Math.sin(i / 2) * 20); await p.mouse.up(); await p.waitForTimeout(400); const n = await p.$$eval('#rd svg.ink path', l => l.length); if (!n) throw new Error('no stroke'); await shot('ink'); return n + ' stroke'; });
    await step('kept after reload', async () => { await p.waitForTimeout(800); await p.reload(); await p.waitForSelector('.pg .pgc', {timeout: 30000}); await p.waitForTimeout(1200); const n = await p.$$eval('#rd svg.ink path', l => l.length); if (!n) throw new Error('stroke lost'); });
    await step('works offline', async () => { await p.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise(r => setTimeout(r, 3000)))); await ctx.setOffline(true); await p.goto(U + '/app/#/library'); await p.reload(); await p.waitForSelector('#view h2, #view h1', {timeout: 15000}); await shot('offline'); await ctx.setOffline(false); });
    if (errs.length) log(`${tag} page errors: ${[...new Set(errs)].slice(0, 5).join(' | ')}`);
    await ctx.close();
  }
  await b.close();
}
srv.close();
lines.push(failed ? 'RESULT: FAILED' : 'RESULT: all passed');
await writeFile(join(out, 'result.txt'), lines.join('\n') + '\n');
process.exit(failed ? 1 : 0);
