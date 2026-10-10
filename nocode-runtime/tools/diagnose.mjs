// Diagnóstico empírico: percorre todas as páginas do app renderizado e coleta gaps do parser.
// Uso: [DIAG_USER=<_id>] node tools/diagnose.mjs [rotas...]   (dev server em http://localhost:3777)
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://localhost:3777';
const OUT = 'data/diagnosis.json';

// Rotas a visitar: passe na linha de comando, ex.: node tools/diagnose.mjs / /login /painel
// (sem argumentos, visita só a página inicial).
const ROUTES = process.argv.slice(2).length ? process.argv.slice(2) : ['/'];
// Opcional: _id do usuário que deve estar logado durante a varredura (pegue no seed-data.json).
const USER = process.env.DIAG_USER || '';

const report = {};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1366, height: 850 } });

// login uma vez (sessionStorage compartilhado por contexto não persiste entre pages; seta direto)
for (const route of ROUTES) {
  const page = await ctx.newPage();
  const warns = [];
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error') errors.push(t);
    else if (t.includes('[nocode-runtime]')) warns.push(t.replace('[nocode-runtime] ', ''));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  try {
    // injeta a sessão do usuário (se informado) antes de carregar
    await page.addInitScript((uid) => {
      try { if (uid) window.sessionStorage.setItem('nc_current_user', uid); } catch (e) {}
    }, USER);
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);
    const metrics = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const placeholders = [...document.querySelectorAll('.nc-plugin-placeholder')].map((e) => e.textContent?.trim().slice(0, 40));
      const overflow = document.documentElement.scrollWidth - vw;
      // elementos com altura 0 mas com filhos (possível colapso indevido)
      let zeroHeight = 0;
      document.querySelectorAll('[data-bid]').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.height === 0 && e.children.length > 0 && getComputedStyle(e).display !== 'none') zeroHeight++;
      });
      const textLen = (document.querySelector('main')?.innerText || '').length;
      return { placeholders, overflow, zeroHeight, textLen, elements: document.querySelectorAll('[data-bid]').length };
    });
    report[route] = { ok: true, warns: tally(warns), errors: errors.slice(0, 5), ...metrics };
  } catch (e) {
    report[route] = { ok: false, error: String(e).slice(0, 200), warns: tally(warns), errors: errors.slice(0, 5) };
  }
  await page.close();
}

await browser.close();

// agregação global
const warnTotals = {};
const placeholderTotals = {};
for (const r of Object.values(report)) {
  for (const [w, n] of Object.entries(r.warns || {})) warnTotals[w] = (warnTotals[w] || 0) + n;
  for (const p of r.placeholders || []) placeholderTotals[p] = (placeholderTotals[p] || 0) + 1;
}
const summary = {
  pages: Object.keys(report).length,
  pagesWithErrors: Object.values(report).filter((r) => (r.errors || []).length > 0).length,
  pagesWithOverflow: Object.values(report).filter((r) => (r.overflow || 0) > 4).length,
  topWarns: Object.entries(warnTotals).sort((a, b) => b[1] - a[1]).slice(0, 30),
  topPlaceholders: Object.entries(placeholderTotals).sort((a, b) => b[1] - a[1]).slice(0, 30),
};

fs.writeFileSync(OUT, JSON.stringify({ summary, report }, null, 1));
console.log(JSON.stringify(summary, null, 1));

function tally(arr) {
  const m = {};
  for (const x of arr) m[x] = (m[x] || 0) + 1;
  return m;
}
