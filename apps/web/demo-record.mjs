// Prod-equivalent full-stack demo recorder (Playwright).
// Drives BOTH ends against the REAL local stack (lumen + redis + mysql +
// ai-sidecar with real Doubao) serving the new antd/Douyin-style frontend:
//   1) host side /#/admin  - Publish auction -> real createProduct->freeze->start->LIVE
//   2) buyer side /#/m     - enter the room -> Join -> Bid now (real WS + Redis Lua adjudication)
// Records an MP4/webm per end + step screenshots. Run from apps/web:
//   node C:/Users/Aufb/AppData/Local/Temp/lumen-demo/record.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:8080';
const OUT = 'C:/Users/Aufb/Desktop/lumen-demo';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[demo]', ...a);

async function shot(page, name) {
  try { await page.screenshot({ path: `${OUT}/${name}.png` }); log('shot', name); } catch (e) { log('shot FAIL', name, e.message); }
}

async function recordAdmin(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: OUT, size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  let auctionName = '[Live] Patek Philippe Annual Calendar Chronograph - demo';
  try {
    await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle' });
    await sleep(1500); await shot(page, '01-admin-home');
    // open Publish auction
    await page.getByText('Publish auction', { exact: true }).first().click();
    await sleep(1200); await shot(page, '02-admin-publish-form');
    // fill in the product name
    const nameInput = page.getByPlaceholder(/Patek Philippe/i).first();
    await nameInput.click(); await nameInput.fill(auctionName);
    await sleep(400); await shot(page, '03-admin-filled');
    // publish → real createProduct→freeze→start→LIVE
    await page.getByRole('button', { name: /Publish and go live/i }).click();
    await sleep(3500); await shot(page, '04-admin-published');
    // jump to Live products to show it live in the real list
    await page.getByText('Live products', { exact: true }).first().click();
    await sleep(2500); await shot(page, '05-admin-product-list');
  } catch (e) {
    log('admin flow error:', e.message); await shot(page, 'admin-error');
  }
  await sleep(800);
  await ctx.close();
  log('admin video saved');
  return auctionName;
}

async function recordBuyer(browser) {
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    isMobile: true,
    recordVideo: { dir: OUT, size: { width: 414, height: 896 } },
  });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/#/m`, { waitUntil: 'networkidle' });
    await sleep(2800); await shot(page, '06-buyer-room'); // LiveRoom on the real LIVE auction
    // 1) open the join sheet (bottom CTA → setSheetTab('join'))
    await page.getByText('Join this auction', { exact: false }).first().click();
    await sleep(900); await shot(page, '07a-join-sheet');
    // 2) agree (.lm-checkbox) -> 3) Accept and join -> real join (sheet -> bid panel)
    await page.locator('.lm-checkbox').first().click();
    await sleep(400); await shot(page, '07b-agreed');
    await page.getByRole('button', { name: /Accept and join/i }).click();
    await sleep(1300); log('joined'); await shot(page, '07c-joined');
    // 4) REAL bids via quick-bid chips (+1 step -> placeBid -> POST /api/auctions/{id}/bids)
    for (let i = 0; i < 5; i++) {
      const chips = page.locator('.lm-chip');
      if (await chips.count()) {
        await chips.first().click();
        log('bid', i + 1);
        await sleep(1700);
        await shot(page, `08-buyer-bid-${i + 1}`);
      } else { log('no bid chip'); break; }
    }
    // show the real leaderboard / my rank
    const overview = page.getByText('Overview', { exact: false }).first();
    if (await overview.count()) { await overview.click(); await sleep(1600); await shot(page, '09-buyer-leaderboard'); }
    await sleep(1500); await shot(page, '10-buyer-final');
  } catch (e) {
    log('buyer flow error:', e.message); await shot(page, 'buyer-error');
  }
  await sleep(800);
  await ctx.close();
  log('buyer video saved');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  log('=== ADMIN (host side) ===');
  await recordAdmin(browser);
  await sleep(1500); // let the new LIVE auction propagate to /api/auctions
  log('=== BUYER (buyer side) ===');
  await recordBuyer(browser);
  await browser.close();
  log('DONE → videos + screenshots in', OUT);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
