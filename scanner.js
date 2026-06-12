import * as cheerio from 'cheerio';

// ── Config ──────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT = 10000;
const PI_CHECK_TIMEOUT = 8000;
const CONCURRENT = 5;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

const GATE_PAGE_PATTERNS = [
  /(?:intended\s+(?:only\s+)?for|designed\s+for)\s+(?:qualified\s+)?(?:healthcare|medical)\s+professional/i,
  /are\s+you\s+a\s+(?:healthcare|medical)\s+professional/i,
  /this\s+(?:site|website|content)\s+is\s+(?:intended|designed)\s+(?:only\s+)?for\s+(?:hcp|healthcare)/i,
  /may\s+contain\s+promotional\s+(?:content|material)/i,
];

const GATE_LINK_PATTERNS = [
  /i[\u2019']?\s*a?m\s+a\s+(?:\w+\s+)*(?:hcp|healthcare\s+professional)/i,
  /yes,?\s+i[\u2019']?\s*a?m\s+a?\s*(?:\w+\s+)*(?:healthcare|medical)\s+professional/i,
  /enter\s+(?:the\s+)?(?:hcp\s+)?site/i,
  /proceed\s+to\s+(?:the\s+)?site/i,
  /i\s+(?:confirm|agree|accept|certif)/i,
  /continue\s+(?:to|as)\s+(?:a\s+)?(?:\w+\s+)*(?:professional|hcp|site|website)/i,
  /access\s+(?:the\s+)?(?:hcp|professional|medical)\s+(?:site|content|area)/i,
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

function resolveUrl(href, base) {
  try { return new URL(href, base).href; }
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

// Genuine PI links carry short labels ("Prescribing Information", "SmPC").
// Card-style anchors wrap whole teaser paragraphs that may mention the SmPC
// in passing — long text must not qualify a link by itself.
const MAX_PI_TEXT_LEN = 90;

function isPILink(href, text) {
  if (PI_URL_PATTERNS.some((p) => p.test(href))) return true;
  if (/\.pdf\b/i.test(href) && PI_FILENAME_PATTERNS.some((p) => p.test(href))) return true;
  if (
    text && text.length <= MAX_PI_TEXT_LEN &&
    !isExcludedPage(href) &&
    PI_TEXT_PATTERNS.some((p) => p.test(text))
  ) return true;
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

// A page whose stripped body text is near-empty but which loads scripts is
// client-rendered; fetch+cheerio cannot see its real content (no browser
// engine on this tier), so it must not be judged for promo/missing-PI.
function looksJsRendered(html, strippedBodyText) {
  return strippedBodyText.trim().length < 200 && /<script[\s>]/i.test(html);
}

// Discover pages from robots.txt + sitemap.xml so SPAs and weakly-linked
// sites still get coverage even when anchor crawling finds nothing.
async function discoverFromSitemap(origin, maxUrls) {
  const sitemapUrls = new Set();
  try {
    const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`, 8000);
    if (robotsRes.ok) {
      const robots = await robotsRes.text();
      for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) sitemapUrls.add(m[1]);
    }
  } catch { /* no robots.txt */ }
  if (sitemapUrls.size === 0) sitemapUrls.add(`${origin}/sitemap.xml`);

  const pages = new Set();
  const queue = [...sitemapUrls].slice(0, 5);
  while (queue.length > 0 && pages.size < maxUrls) {
    const smUrl = queue.shift();
    try {
      const res = await fetchWithTimeout(smUrl, 10000);
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
      const isIndex = /<sitemapindex/i.test(xml);
      for (const loc of locs) {
        if (isIndex) { if (queue.length < 10) queue.push(loc); }
        else if (isSameOrigin(loc, origin)) pages.add(loc);
        if (pages.size >= maxUrls) break;
      }
    } catch { /* unreadable sitemap */ }
  }
  return [...pages];
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      redirect: 'follow',
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Main scan function ──────────────────────────────────────────────────────
export async function scanUrl(url, options = {}) {
  const maxDepth = options.maxDepth ?? 2;
  const maxPages = options.maxPages ?? 50;
  const skipGate = options.skipGate ?? false;
  const onProgress = options.onProgress ?? (() => {});

  const startTime = Date.now();
  let crawlTarget = url;
  const origin = new URL(url).origin;

  // ── Gateway detection (fetch-based) ───────────────────────────────────────
  // With fetch we can't click buttons, but we can detect gate pages and
  // follow any <a> links that match HCP confirmation patterns.
  if (!skipGate) {
    try {
      const res = await fetchWithTimeout(url, 15000);
      if (res.ok) {
        const html = await res.text();
        const $ = cheerio.load(html);
        const bodyText = $('body').text();
        const isGatePage = GATE_PAGE_PATTERNS.some((p) => p.test(bodyText));

        if (isGatePage) {
          onProgress({ type: 'gateway', message: 'HCP gateway detected — looking for confirmation link' });

          // Find <a> links that look like gate confirmation
          let gateHref = null;
          $('a[href]').each((_, el) => {
            if (gateHref) return;
            const text = $(el).text().trim();
            const href = $(el).attr('href');
            if (text && GATE_LINK_PATTERNS.some((p) => p.test(text)) && href) {
              gateHref = normalizeUrl(href, url);
            }
          });

          if (gateHref) {
            crawlTarget = gateHref;
            onProgress({ type: 'gateway', message: `Following gate link: ${gateHref}` });
          } else {
            onProgress({ type: 'gateway', message: 'Gate page detected but no confirmation link found (JS-only gate)' });
          }
        }
      }
    } catch (err) {
      onProgress({ type: 'error', message: `Gateway check error: ${err.message}` });
    }
  }

  // ── Fetch and parse a page ────────────────────────────────────────────────
  const visited = new Set();
  const queue = [{ url: crawlTarget, depth: 0 }];
  const results = [];

  // Sitemap-first discovery: seed the queue so coverage doesn't depend on
  // anchor crawling alone (SPAs often expose pages only via sitemap.xml).
  let discovery = 'crawl';
  try {
    const sitemapPages = await discoverFromSitemap(origin, maxPages * 2);
    if (sitemapPages.length > 0) {
      discovery = 'sitemap+crawl';
      onProgress({ type: 'sitemap', message: `Sitemap discovery found ${sitemapPages.length} pages` });
      for (const p of sitemapPages) queue.push({ url: p, depth: 1 });
    }
  } catch { /* discovery is best-effort */ }
  // Global cache: check each PI URL only once across all pages
  const piCheckCache = new Map();

  async function checkPILink(pi) {
    // Strip hash for the actual HTTP check (servers ignore fragments)
    const checkUrl = normalizeUrl(pi.url, pi.url) || pi.url;
    if (piCheckCache.has(checkUrl)) {
      const cached = piCheckCache.get(checkUrl);
      return { url: pi.url, text: pi.text, status: cached.status, ok: cached.ok, issue: cached.issue };
    }
    try {
      const piRes = await fetchWithTimeout(checkUrl, PI_CHECK_TIMEOUT);
      const s = piRes.status;
      const body = await piRes.text().catch(() => '');
      const titleMatch = body.match(/<title[^>]*>([^<]*)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';
      const hasContent = (body.length > 500) && !/not found|error|404/i.test(title);
      const ok = (s >= 200 && s < 400) || hasContent;
      const issue = !ok
        ? s === 404 ? 'PI not found (404)'
        : s === 403 ? 'PI access forbidden (403)'
        : s === 410 ? 'PI page gone (410)'
        : s === 0 ? 'No response from server'
        : `Server returned HTTP ${s}`
        : null;
      const status = ok ? (s >= 200 && s < 400 ? s : 200) : s;
      piCheckCache.set(checkUrl, { status, ok, issue });
      return { url: pi.url, text: pi.text, status, ok, issue };
    } catch (err) {
      const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError';
      const issue = isTimeout ? 'Connection timed out' : err.message;
      piCheckCache.set(checkUrl, { status: 0, ok: false, issue });
      return { url: pi.url, text: pi.text, status: 0, ok: false, issue };
    }
  }

  async function fetchAndParse(pageUrl, depth) {
    try {
      const res = await fetchWithTimeout(pageUrl);
      const status = res.status;

      if (status === 403 || status === 401) return { result: null, links: [] };

      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html')) return { result: null, links: [] };

      const html = await res.text();
      const $ = cheerio.load(html);
      $('script, style, noscript').remove();
      const bodyText = $('body').text();
      const jsRendered = looksJsRendered(html, bodyText);

      const piLinks = [];
      const piSeen = new Set();
      const links = [];
      const linkSeen = new Set();

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        // For crawl links, strip hash to avoid duplicate crawls
        const crawlResolved = normalizeUrl(href, pageUrl);
        // For PI links, preserve hash to distinguish anchors (e.g. #trimbow vs #fostair)
        const fullResolved = resolveUrl(href, pageUrl);
        if (!crawlResolved) return;

        if (isSameOrigin(crawlResolved, origin) && !linkSeen.has(crawlResolved)) {
          linkSeen.add(crawlResolved);
          links.push(crawlResolved);
        }

        if (isPILink(crawlResolved, text) && fullResolved && !piSeen.has(fullResolved)) {
          piSeen.add(fullResolved);
          piLinks.push({ url: fullResolved, text: text.slice(0, 120) });
        }
      });

      const excluded = isExcludedPage(pageUrl);
      // JS-rendered pages can't be judged from raw HTML — never flag them.
      const isPromo = !excluded && !jsRendered && hasPromotionalContent(bodyText);
      const missingPI = isPromo && piLinks.length === 0;

      // Check PI links with fetch in batches of 5 (uses global cache)
      const checked = [];
      for (let i = 0; i < piLinks.length; i += 5) {
        const batch = piLinks.slice(i, i + 5);
        const batchResults = await Promise.all(batch.map(checkPILink));
        checked.push(...batchResults);
      }

      const short = shortUrl(pageUrl, origin);
      onProgress({ type: 'page', page: short, piLinks: checked.length, promo: isPromo, excluded });

      return {
        result: { page: short, pi_links: checked, has_promotional_content: isPromo, missing_pi: missingPI, ...(excluded ? { excluded: true } : {}), ...(jsRendered ? { js_rendered: true } : {}) },
        links,
      };
    } catch {
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

    const settled = await Promise.allSettled(batch.map((b) => fetchAndParse(b.url, b.depth)));

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

  // ── Build response ──────────────────────────────────────────────────────
  const allLinks = results.flatMap((r) => r.pi_links);
  // Deduplicate PI links globally for the summary count
  const uniquePIUrls = new Set(allLinks.map((l) => l.url));
  const pass = allLinks.filter((l) => l.ok).length;
  const fail = allLinks.filter((l) => !l.ok && l.issue !== null).length;
  const warn = results.filter((r) => r.missing_pi).length;
  const jsRenderedPages = results.filter((r) => r.js_rendered).length;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const warnings = [];
  if (jsRenderedPages > 0) {
    warnings.push(`${jsRenderedPages} page(s) appear to be JavaScript-rendered; their content cannot be fully verified without a browser engine, so PI findings on those pages may be incomplete.`);
  }

  return {
    target: crawlTarget,
    pages_scanned: results.length,
    scan_time_seconds: parseFloat(elapsed),
    discovery,
    results,
    summary: {
      pages_scanned: results.length,
      pi_links_found: uniquePIUrls.size,
      pass,
      fail,
      warn,
      js_rendered_pages: jsRenderedPages,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
