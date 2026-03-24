import * as cheerio from 'cheerio';
import { chromium } from 'playwright';

// ── Config ──────────────────────────────────────────────────────────────────
const PAGE_TIMEOUT = 10000;
const PI_CHECK_TIMEOUT = 8000;
const CONCURRENT = 3;

// ── Patterns ────────────────────────────────────────────────────────────────
const PROMO_PATTERNS = [
  /\b(?:efficacy|effective(?:ness)?)\s+(?:in|of|for|was|data|results?)\b/i,
  /\b(?:superior(?:ity)?|non[- ]inferior(?:ity)?)\s+(?:to|vs|versus|compared)\b/i,
  /\b(?:significant(?:ly)?\s+(?:improved|reduced|better|greater|more))\b/i,
  /\b(?:primary\s+endpoint|secondary\s+endpoint|overall\s+survival|progression[- ]free)\b/i,
  /\b(?:p\s*[<=]\s*0\.\d+|hazard\s+ratio|confidence\s+interval|odds\s+ratio)\b/i,
  /\b(?:recommended\s+dos(?:e|ing|age)|dose[- ]?adjustment|mg\s+(?:once|twice|daily))\b/i,
  /\b(?:indicated?\s+for\s+(?:the\s+)?treatment)\b/i,
  /\b(?:administer(?:ed)?|inject(?:ed|ion)?|infus(?:ed|ion)?|oral(?:ly)?)\s/i,
  /\b(?:adverse\s+(?:event|reaction|effect)s?\s+(?:were|included|reported|observed))\b/i,
  /\b(?:contraindicated|contraindication|warnings?\s+and\s+precaution)/i,
  /\b(?:approved\s+(?:for|by|in)|marketing\s+authoris?ation|licence[d]?\s+(?:for|indication))\b/i,
];
const PROMO_THRESHOLD = 3;

const PI_URL_PATTERNS = [
  /medicines\.org\.uk\/emc/i,
  /ema\.europa\.eu.*product/i,
  /accessdata\.fda\.gov/i,
  /mhra\.gov\.uk/i,
];
const PI_FILENAME_PATTERNS = [/\b(?:pi|prescribing|smpc|spc|pil)\b/i];
const PI_TEXT_PATTERNS = [
  /prescribing\s+information/i, /\bsmpc\b/i, /\bspc\b/i,
  /\bfull\s+prescribing\b/i, /\bsummary\s+of\s+product\s+characteristics\b/i,
  /\bpackage\s+(?:leaflet|insert)\b/i, /\brefer\s+to\s+(?:the\s+)?smpc\b/i,
  /\bpi\s+(?:available|link|document)\b/i,
];

const GATE_BUTTON_PATTERNS = [
  /i[\u2019']?\s*a?m\s+a\s+(?:\w+\s+)*(?:hcp|healthcare\s+professional)/i,
  /yes,?\s+i[\u2019']?\s*a?m\s+a?\s*(?:\w+\s+)*(?:healthcare|medical)\s+professional/i,
  /i\s+am\s+(?:a\s+)?(?:\w+\s+)*(?:prescrib|doctor|physician|pharmacist|nurse|clinician)/i,
  /enter\s+(?:the\s+)?(?:hcp\s+)?site/i,
  /proceed\s+to\s+(?:the\s+)?site/i,
  /i\s+(?:confirm|agree|accept|certif)/i,
  /continue\s+(?:to|as)\s+(?:a\s+)?(?:\w+\s+)*(?:professional|hcp|site|website)/i,
  /access\s+(?:the\s+)?(?:hcp|professional|medical)\s+(?:site|content|area)/i,
];
const GATE_PAGE_PATTERNS = [
  /(?:intended\s+(?:only\s+)?for|designed\s+for)\s+(?:qualified\s+)?(?:healthcare|medical)\s+professional/i,
  /are\s+you\s+a\s+(?:healthcare|medical)\s+professional/i,
  /this\s+(?:site|website|content)\s+is\s+(?:intended|designed)\s+(?:only\s+)?for\s+(?:hcp|healthcare)/i,
  /may\s+contain\s+promotional\s+(?:content|material)/i,
];

const COOKIE_BANNER_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.onetrust-close-btn-handler',
  '#acceptAllDiv',
  '#accept-all-text',
  '[id*="cookie"] button[class*="accept"]',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '.cc-btn.cc-dismiss',
  'button:has-text("Accept All Cookies")',
  'button:has-text("Accept all cookies")',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Allow all")',
  'button:has-text("Allow All")',
  '[data-testid="cookie-accept"]',
];

// Pages excluded from PI link requirements (press releases, corporate pages)
const EXCLUDED_PATH_PATTERNS = [
  /\/(?:newsroom|news|press|media)\b/i,
  /\/press[_-]?release/i,
  /\/investor/i,
  /\/about\b/i,
  /\/careers?\b/i,
  /\/contact\b/i,
  /\/privacy/i,
  /\/terms/i,
  /\/cookie/i,
  /\/legal/i,
  /\/sitemap/i,
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function normalizeUrl(href, base) {
  try { const u = new URL(href, base); u.hash = ''; return u.href; }
  catch { return null; }
}

function isSameOrigin(url, origin) {
  try { return new URL(url).origin === origin; }
  catch { return false; }
}

function shortUrl(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin === origin) return u.pathname + u.search;
    return url.length > 80 ? url.slice(0, 77) + '...' : url;
  } catch { return url; }
}

function isPILink(href, text) {
  if (PI_URL_PATTERNS.some((p) => p.test(href))) return true;
  if (/\.pdf\b/i.test(href) && PI_FILENAME_PATTERNS.some((p) => p.test(href))) return true;
  if (text && PI_TEXT_PATTERNS.some((p) => p.test(text))) return true;
  return false;
}

function hasPromotionalContent(text) {
  let m = 0;
  for (const p of PROMO_PATTERNS) { if (p.test(text) && ++m >= PROMO_THRESHOLD) return true; }
  return false;
}

function isExcludedPage(url) {
  try {
    const path = new URL(url).pathname;
    return EXCLUDED_PATH_PATTERNS.some((p) => p.test(path));
  } catch { return false; }
}

// ── Main scan function ──────────────────────────────────────────────────────
export async function scanUrl(url, options = {}) {
  const maxDepth = options.maxDepth ?? 2;
  const maxPages = options.maxPages ?? 50;
  const skipGate = options.skipGate ?? false;
  const onProgress = options.onProgress ?? (() => {});

  const startTime = Date.now();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  let crawlTarget = url;
  const origin = new URL(url).origin;

  // ── Cookie banner dismissal ─────────────────────────────────────────────
  async function dismissCookieBanner(page) {
    for (const sel of COOKIE_BANNER_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 500 })) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(500);
          return;
        }
      } catch {}
    }
  }

  // ── Gateway breaker ─────────────────────────────────────────────────────
  if (!skipGate) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1000);
      await dismissCookieBanner(page);

      const bodyText = await page.textContent('body') || '';
      const isGatePage = GATE_PAGE_PATTERNS.some((p) => p.test(bodyText));

      if (isGatePage) {
        onProgress({ type: 'gateway', message: 'HCP gateway detected' });

        for (const cb of await page.locator('input[type="checkbox"]').all()) {
          try {
            if (!await cb.isVisible()) continue;
            const id = await cb.getAttribute('id');
            let labelText = id ? (await page.locator(`label[for="${id}"]`).textContent().catch(() => '')) || '' : '';
            if (!labelText) labelText = await cb.locator('xpath=ancestor::label').textContent().catch(() => '') || '';
            if (/(?:confirm|agree|professional|hcp|certif|acknowledg)/i.test(labelText)) {
              await cb.check();
            }
          } catch {}
        }

        const candidates = [];
        for (const el of await page.locator('a, button, input[type="submit"], input[type="button"], [role="button"]').all()) {
          try {
            if (!await el.isVisible({ timeout: 300 })) continue;
            const text = ((await el.textContent()) || '').trim();
            const value = (await el.getAttribute('value')) || '';
            const label = text || value;
            if (label && GATE_BUTTON_PATTERNS.some((p) => p.test(label))) {
              candidates.push({ el, label });
            }
          } catch {}
        }

        if (candidates.length > 0) {
          candidates.sort((a, b) => b.label.length - a.label.length);
          await candidates[0].el.click({ timeout: 5000, force: true });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(2000);

          const finalUrl = page.url();
          if (new URL(finalUrl).origin !== new URL(url).origin) {
            crawlTarget = finalUrl;
          }
          onProgress({ type: 'gateway', message: 'Gateway cleared' });
        }
      }
    } catch (err) {
      onProgress({ type: 'error', message: `Gateway check error: ${err.message}` });
    }
    await page.close();
  }

  // ── Page renderer ─────────────────────────────────────────────────────────
  const visited = new Set();
  const queue = [{ url: crawlTarget, depth: 0 }];
  const results = [];

  async function renderAndParse(pageUrl, depth) {
    const page = await context.newPage();

    try {
      const response = await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: PAGE_TIMEOUT });
      if (!response) { await page.close(); return { result: null, links: [] }; }

      const status = response.status();
      if (status === 403 || status === 401) {
        await page.close();
        return { result: null, links: [] };
      }

      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('text/html')) { await page.close(); return { result: null, links: [] }; }

      await page.waitForTimeout(500);
      const html = await page.content();
      await page.close();

      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      const bodyText = $('body').text();

      const piLinks = [];
      const piSeen = new Set();
      const links = [];
      const linkSeen = new Set();

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        const resolved = normalizeUrl(href, pageUrl);
        if (!resolved) return;

        if (isSameOrigin(resolved, origin) && !linkSeen.has(resolved)) {
          linkSeen.add(resolved);
          links.push(resolved);
        }

        if (isPILink(resolved, text) && !piSeen.has(resolved)) {
          piSeen.add(resolved);
          piLinks.push({ url: resolved, text: text.slice(0, 120) });
        }
      });

      const excluded = isExcludedPage(pageUrl);
      const isPromo = !excluded && hasPromotionalContent(bodyText);
      const missingPI = isPromo && piLinks.length === 0;

      // Check PI links in batches of 5 to avoid overwhelming the browser
      const checked = [];
      for (let i = 0; i < piLinks.length; i += 5) {
        const batch = piLinks.slice(i, i + 5);
        const batchResults = await Promise.all(
          batch.map(async (pi) => {
            try {
              const checkPage = await context.newPage();
              const res = await checkPage.goto(pi.url, { waitUntil: 'domcontentloaded', timeout: PI_CHECK_TIMEOUT });
              const s = res ? res.status() : 0;
              const title = await checkPage.title().catch(() => '');
              await checkPage.close();
              const hasContent = title && title.length > 5 && !/not found|error|404/i.test(title);
              const ok = (s >= 200 && s < 400) || hasContent;
              const issue = !ok
                ? s === 404 ? 'PI not found (404)'
                : s === 403 ? 'PI forbidden (403)'
                : s === 410 ? 'PI gone (410)'
                : s === 0 ? 'No response'
                : `HTTP ${s}` : null;
              return { url: pi.url, text: pi.text, status: ok ? (s >= 200 && s < 400 ? s : 200) : s, ok, ...(issue ? { issue } : {}) };
            } catch (err) {
              return { url: pi.url, text: pi.text, status: 0, ok: false, issue: err.name === 'TimeoutError' ? 'Timeout' : err.message };
            }
          })
        );
        checked.push(...batchResults);
      }

      const short = shortUrl(pageUrl, origin);
      onProgress({ type: 'page', page: short, piLinks: checked.length, promo: isPromo, excluded });

      return {
        result: { page: short, pi_links: checked, has_promotional_content: isPromo, missing_pi: missingPI, ...(excluded ? { excluded: true } : {}) },
        links,
      };
    } catch (err) {
      await page.close().catch(() => {});
      return { result: null, links: [] };
    }
  }

  // ── BFS crawl ─────────────────────────────────────────────────────────────
  while (queue.length > 0 && visited.size < maxPages) {
    const batch = [];
    while (batch.length < CONCURRENT && queue.length > 0) {
      const item = queue.shift();
      const norm = normalizeUrl(item.url, origin);
      if (!norm || visited.has(norm)) continue;
      visited.add(norm);
      batch.push({ url: norm, depth: item.depth });
    }

    const settled = await Promise.allSettled(batch.map((b) => renderAndParse(b.url, b.depth)));

    for (let i = 0; i < settled.length; i++) {
      if (settled[i].status !== 'fulfilled') continue;
      const { result, links } = settled[i].value;
      if (result) results.push(result);

      if (batch[i].depth < maxDepth) {
        for (const link of links) {
          if (!visited.has(link) && visited.size + queue.length < maxPages * 2) {
            queue.push({ url: link, depth: batch[i].depth + 1 });
          }
        }
      }
    }
  }

  await browser.close();

  // ── Build response ──────────────────────────────────────────────────────
  const allLinks = results.flatMap((r) => r.pi_links);
  const pass = allLinks.filter((l) => l.ok).length;
  const fail = allLinks.filter((l) => !l.ok).length;
  const warn = results.filter((r) => r.missing_pi).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    target: crawlTarget,
    pages_scanned: results.length,
    scan_time_seconds: parseFloat(elapsed),
    results,
    summary: { total: allLinks.length, pass, fail, warn, missing_pi_pages: warn },
  };
}
