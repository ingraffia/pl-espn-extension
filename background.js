/**
 * background.js — PitcherList Rank Overlay
 *
 * Sources:
 *   sp  — The List (SP)          — numbered format
 *   rp  — Closing Time (RP)      — numbered (in-season) or table (preseason)
 *   h   — Hitter List            — numbered format
 */

'use strict';

const CACHE_KEY  = 'plRankings';
const ALARM_NAME = 'plDailyRefresh';

const SOURCES = {
  sp: {
    categoryUrl: 'https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/',
    urlMustContain: 'starting-pitcher',
    directUrl: 'https://pitcherlist.com/top-100-starting-pitchers-for-2026-fantasy-baseball-4-6-week-3-rankings/',
    maxRank:   100,
  },
  rp: {
    categoryUrl: 'https://pitcherlist.com/category/fantasy/relief-pitchers/closing-time/',
    maxRank: 300,
  },
  h: {
    categoryUrl: 'https://pitcherlist.com/category/fantasy/hitters-fantasy/hitter-list/',
    urlMustContain: 'hitter',
    directUrl: 'https://pitcherlist.com/top-150-hitters-for-fantasy-baseball-2026-weeks-1-2/',
    maxRank:   150,
  },
  prospect: {
    directUrl: 'https://pitcherlist.com/2026-prospect-list-top-150-dynasty-prospects/',
    maxRank: 150,
  },
  sitstart: {
    categoryUrl: 'https://pitcherlist.com/category/fantasy/starting-pitchers/sit-or-start/',
    urlMustContain: 'sit-start',
    maxRank: 999,
    isSitStart: true, // skip minimum entry validation
  },
};

// ── Lifecycle ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  fetchAndStore();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(CACHE_KEY, (data) => {
    const cached = data[CACHE_KEY];
    const stale  = !cached || (Date.now() - cached.fetchedAt) > 12 * 60 * 60 * 1000;
    if (stale) fetchAndStore();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) fetchAndStore();
});

// ── Messages ───────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_RANKINGS') {
    chrome.storage.local.get(CACHE_KEY, (data) => sendResponse(data[CACHE_KEY] ?? null));
    return true;
  }
  if (msg.type === 'FORCE_REFRESH') {
    chrome.storage.local.remove(CACHE_KEY, () => {
      fetchAndStore().then(() => sendResponse({ ok: true }));
    });
    return true;
  }
  if (msg.type === 'SYNC_DRAFT_PRICES') {
    syncESPNDraftPrices().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

// ── ESPN draft price sync ──────────────────────────────────────────────────
// Reads ESPN's auth cookies (SWID + espn_s2) directly via chrome.cookies API,
// then fetches the internal draft + roster API from the background service worker.

async function syncESPNDraftPrices() {
  const LEAGUE_ID = 188796;
  const YEAR      = 2026;
  const domain    = 'fantasy.espn.com';
  const base      = `https://${domain}/apis/v3/games/flb/seasons/${YEAR}/segments/0/leagues/${LEAGUE_ID}`;

  // Try public access first (many ESPN leagues are public).
  // If that returns HTML (login redirect), fall back to cookie-forwarded fetch.
  console.log('[PL] Fetching ESPN draft + roster data...');

  async function espnFetch(url) {
    // With *.espn.com in host_permissions the background service worker
    // can follow ESPN's redirect to www.espn.com with credentials
    let r = await fetch(url, { credentials: 'include' });
    let ct = r.headers.get('content-type') ?? '';
    if (r.ok && ct.includes('json')) return r.json();

    // Still getting HTML — try attaching cookies explicitly as query params
    const [swidCookie, s2Cookie] = await Promise.all([
      chrome.cookies.get({ url: `https://fantasy.espn.com`, name: 'SWID' }),
      chrome.cookies.get({ url: `https://fantasy.espn.com`, name: 'espn_s2' }),
    ]);
    console.log('[PL] SWID found:', !!swidCookie, 'espn_s2 found:', !!s2Cookie);

    if (swidCookie && s2Cookie) {
      const sep  = url.includes('?') ? '&' : '?';
      const auth = `espn_s2=${encodeURIComponent(s2Cookie.value)}&SWID=${encodeURIComponent(swidCookie.value)}`;
      r = await fetch(`${url}${sep}${auth}`, { credentials: 'include' });
      ct = r.headers.get('content-type') ?? '';
      if (r.ok && ct.includes('json')) return r.json();
    }

    const body = await r.text();
    throw new Error(`ESPN API ${r.status} (${ct.slice(0,30)}) — ${body.slice(0, 100)}`);
  }

  const [draftRes, rosterRes] = await Promise.all([
    espnFetch(`${base}?view=mDraftDetail`),
    espnFetch(`${base}?view=mRoster`),
  ]);

  const picks = draftRes?.draftDetail?.picks ?? [];
  console.log(`[PL] ${picks.length} draft picks`);
  if (!picks.length) throw new Error('No draft picks found — has the draft happened yet?');

  // playerId → bid amount
  const draftPriceById = {};
  for (const pick of picks) {
    if (pick.bidAmount != null && pick.playerId) {
      draftPriceById[pick.playerId] = pick.bidAmount;
    }
  }

  const teams = rosterRes?.teams ?? [];
  if (!teams.length) throw new Error('No teams found in roster response');

  const keeperMap = {};
  for (const team of teams) {
    for (const entry of (team?.roster?.entries ?? [])) {
      const id   = entry.playerId;
      const info = entry.playerPoolEntry?.playerInfo ?? entry.playerPoolEntry?.player ?? {};
      const name = info.fullName ?? (info.firstName ? `${info.firstName} ${info.lastName}` : null);
      if (!name || !id) continue;
      const norm  = normalizeName(name);
      const price = draftPriceById[id] != null ? Math.max(1, draftPriceById[id]) : 1;
      keeperMap[norm] = { price, displayName: name };
    }
  }

  const total = Object.keys(keeperMap).length;
  if (!total) throw new Error('Parsed 0 players from roster');

  await chrome.storage.local.set({ plKeepers: keeperMap });

  const drafted = Object.values(keeperMap).filter(v => v.price > 1).length;
  const pickups = total - drafted;
  console.log(`[PL] Sync complete: ${drafted} drafted, ${pickups} $1 pickups`);
  return { ok: true, drafted, pickups };
}

function normalizeName(name) {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s'.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Core fetch + store ─────────────────────────────────────────────────────

async function fetchAndStore() {
  const results = {};
  const errors  = {};

  await Promise.allSettled(
    Object.entries(SOURCES).map(async ([type, config]) => {
      try {
        results[type] = await fetchRankings(type, config);
        console.log(`[PL] Fetched ${results[type].length} ${type.toUpperCase()} rankings`);
      } catch (err) {
        errors[type] = err.message;
        console.error(`[PL] ${type} fetch failed:`, err);
      }
    })
  );

  const existing = await getExistingCache();

  const payload = {
    sp:        results.sp       ?? existing.sp       ?? [],
    rp:        results.rp       ?? existing.rp       ?? [],
    h:         results.h        ?? existing.h        ?? [],
    prospect:  results.prospect ?? existing.prospect ?? [],
    sitstart:  results.sitstart ?? existing.sitstart ?? [],
    fetchedAt: Date.now(),
    errors:    Object.keys(errors).length ? errors : null,
    // Snapshot previous rankings for delta display — only update prev when we
    // have fresh data (not just falling back to existing)
    prevSp:      results.sp      ? (existing.sp      ?? []) : (existing.prevSp      ?? []),
    prevRp:      results.rp      ? (existing.rp      ?? []) : (existing.prevRp      ?? []),
    prevH:       results.h       ? (existing.h       ?? []) : (existing.prevH       ?? []),
    prevProspect:results.prospect? (existing.prospect ?? []) : (existing.prevProspect ?? []),
    prevSitstart:results.sitstart? (existing.sitstart ?? []) : (existing.prevSitstart ?? []),
  };

  await chrome.storage.local.set({ [CACHE_KEY]: payload });
  console.log(`[PL] Stored ${payload.sp.length} SP, ${payload.rp.length} RP, ${payload.h.length} H, ${payload.prospect.length} Prospects, ${payload.sitstart.length} Sit/Start`);
  return payload;
}

async function getExistingCache() {
  return new Promise((resolve) =>
    chrome.storage.local.get(CACHE_KEY, (data) => resolve(data[CACHE_KEY] ?? {}))
  );
}

// ── Rankings fetch ─────────────────────────────────────────────────────────

async function fetchRankings(type, config) {
  let articleHtml;
  let articleUrl = config.directUrl ?? config.categoryUrl ?? config.wpJsonUrl;

  // Auto-discover latest article via WP search API (newest first)
  if (config.wpApiUrl && config.wpSearch) {
    try {
      const searchUrl = `https://pitcherlist.com/wp-json/wp/v2/posts?search=${encodeURIComponent(config.wpSearch)}&per_page=5&orderby=date&order=desc&_fields=link`;
      const json = await httpGet(searchUrl);
      const posts = JSON.parse(json);
      // Match by slug keywords that appear in PitcherList article URLs
      const slugKeywords = { sp: 'starting-pitchers', h: 'hitter' };
      const slugKey = slugKeywords[type] ?? config.wpSearch.replace(' ', '-');
      const latest = posts?.find(p => p.link && p.link.includes(slugKey));
      if (latest?.link) {
        articleUrl = latest.link.endsWith('/') ? latest.link : latest.link + '/';
        console.log(`[PL] WP API found latest ${type}: ${articleUrl}`);
      } else {
        throw new Error('no matching post');
      }
    } catch(e) {
      // Fall back to hardcoded directUrl
      articleUrl = config.directUrl;
      console.log(`[PL] WP API failed (${e.message}), using directUrl: ${articleUrl}`);
    }
  } else if (config.wpJsonUrl) {
    // Use WordPress REST API — returns clean rendered HTML, no nav/ads
    const json = await httpGet(config.wpJsonUrl);
    let parsed;
    try { parsed = JSON.parse(json); } catch(e) { throw new Error(`WP JSON parse failed: ${e.message}`); }
    if (!parsed?.[0]?.content?.rendered) throw new Error('WP JSON returned no content');
    articleHtml = parsed[0].content.rendered;
    console.log(`[PL] WP JSON fetched, content length: ${articleHtml.length}`);
  } else if (config.categoryUrl) {
    // Try category page first to get the latest article URL
    try {
      const categoryHtml = await httpGet(config.categoryUrl);
      const latestUrl    = extractFirstArticleUrl(categoryHtml, config.urlMustContain);
      if (latestUrl) {
        articleUrl = latestUrl;
        console.log(`[PL] Category found latest: ${latestUrl}`);
      } else {
        throw new Error('no url from category');
      }
    } catch (e) {
      // Fall back to hardcoded directUrl
      if (!config.directUrl) throw new Error(`Could not find article on category page: ${config.categoryUrl}`);
      articleUrl = config.directUrl;
      console.log(`[PL] Category failed (${e.message}), using directUrl: ${articleUrl}`);
    }
  } else if (config.directUrl) {
    articleUrl = config.directUrl;
  }

  if (!articleUrl) throw new Error(`No article URL resolved for ${type}`);
  if (!articleHtml) {
    console.log(`[PL] ${type.toUpperCase()} article: ${articleUrl}`);
    articleHtml = await httpGet(articleUrl);
  }

  // Debug: find where article body starts and log that instead
  const bodyIdx = articleHtml.indexOf('entry-content') > -1 ? articleHtml.indexOf('entry-content')
                : articleHtml.indexOf('post-content') > -1 ? articleHtml.indexOf('post-content')
                : articleHtml.indexOf('article-body') > -1 ? articleHtml.indexOf('article-body')
                : Math.floor(articleHtml.length / 2); // fallback: mid-page
  const snippet = articleHtml.slice(bodyIdx, bodyIdx + 800).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  console.log(`[PL] ${type} body snippet (at ${bodyIdx}/${articleHtml.length}):`, snippet);

  let rankings = parseNumberedRankings(articleHtml, type, config.maxRank);

  // RP preseason articles use team tables instead of numbered list
  if (rankings.length < 5 && type === 'rp') {
    console.log(`[PL] RP numbered parse got ${rankings.length} — trying table parser`);
    rankings = parseRPFromTables(articleHtml, config.maxRank);
  }

  // Prospect list uses a rank | player-link | team | pos | age table
  if (rankings.length < 5 && type === 'prospect') {
    console.log(`[PL] Prospect numbered parse got ${rankings.length} — trying prospect table parser`);
    rankings = parseProspectTable(articleHtml, config.maxRank);
  }

  // For hitters: extract just the article body then run plain-text parser
  // The Top 300 article mixes <strong><a> links and plain "N. Name (POS)" text
  if (type === 'h') {
    // Extract just article body to reduce noise for plain text parser
    let bodyHtml = articleHtml;
    // Pass full HTML — the plain parser's regex is precise enough to avoid false positives
    // Slicing caused Carroll (#10) to be cut off since it appears before index 179235
    bodyHtml = articleHtml;
    const weeklyResults = parseWeeklyHitterTable(bodyHtml, config.maxRank);
    const tableResults  = weeklyResults.length > 0 ? [] : parseHitterTable(bodyHtml, config.maxRank);
    const plainResults  = parsePlainNumberedList(bodyHtml, config.maxRank);
    // If the new weekly table format found results, use them as the base rankings
    if (weeklyResults.length > 0) {
      rankings = weeklyResults;
      console.log(`[PL] using weekly hitter table: ${rankings.length} entries`);
    }
    if (plainResults.length > 0) {
      // Merge by normalized name — plain parser fills in players missing from link parser
      // If the same player exists in both, use the lower (better) rank
      const nameToIdx = new Map(rankings.map((r, i) => [r.normalizedName, i]));
      // Merge table results first (ranks 151-300)
      for (const r of [...tableResults, ...plainResults]) {
        if (nameToIdx.has(r.normalizedName)) {
          // Player already exists — update rank if plain parser has a better one
          const idx = nameToIdx.get(r.normalizedName);
          if (r.rank < rankings[idx].rank) rankings[idx].rank = r.rank;
        } else {
          rankings.push(r);
          nameToIdx.set(r.normalizedName, rankings.length - 1);
        }
      }
      rankings.sort((a, b) => a.rank - b.rank);
      console.log(`[PL] H merged: ${rankings.length} total entries`);
    }
  }

  // Sit/Start uses matchup tables — parse and return early, skip the < 5 check
  if (type === 'sitstart') {
    rankings = parseSitStart(articleHtml);
    console.log(`[PL] Sit/Start: ${rankings.length} entries`);
    return rankings.map((r) => ({ ...r, articleUrl }));
  }

  if (rankings.length < 5 && type !== 'h') {
    throw new Error(`Only parsed ${rankings.length} entries after all strategies`);
  }

  return rankings.map((r) => ({ ...r, articleUrl }));
}

async function httpGet(url) {
  const res = await fetch(url, { headers: { 'Accept': 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── URL extraction ─────────────────────────────────────────────────────────

function extractFirstArticleUrl(html, mustContain) {
  const hrefRe = /href="(https:\/\/pitcherlist\.com\/[^"#?]+)"/gi;

  const SKIP = [
    '/category/', '/author/', '/player/', '/teams/', '/tag/', '/page/',
    '/premium', '/plus', '/about', '/masthead', '/privacy', '/hiring',
    '/glossary', '/leaderboard', '/podcasts', '/pitchcon', '/csw-rate',
    '/pitcher-arsenal', '/pl-pro-tools', '/plv-leaderboard', '/login',
    '/wp-json', '/wp-content', '/wp-admin',
  ];

  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const url  = m[1].endsWith('/') ? m[1] : m[1] + '/';
    const slug = url.replace('https://pitcherlist.com/', '');
    if (!slug || slug === '/') continue;
    if (SKIP.some((s) => url.includes(s))) continue;
    if (!slug.includes('-')) continue;
    if (mustContain && !url.includes(mustContain)) continue;
    return url;
  }
  return null;
}

// ── Parser A: Numbered list ────────────────────────────────────────────────

function parseNumberedRankings(html, type, maxRank) {
  const rankings  = [];
  const seenRanks = new Set();
  const seenNames = new Set();

  const re = /<strong[^>]*>\s*(\d{1,3})\.\s*<a\b[^>]*href="https:\/\/pitcherlist\.com\/player\/[^"]*"[^>]*>([^<]+)<\/a>/gi;

  let m;
  while ((m = re.exec(html)) !== null) {
    const rank = parseInt(m[1], 10);
    const name = decodeHtmlEntities(m[2]).trim();

    if (rank < 1 || rank > maxRank)            continue;
    if (seenRanks.has(rank))                   continue;
    if (!name || name.split(/\s+/).length < 2) continue;
    if (seenNames.has(name.toLowerCase()))     continue;

    seenRanks.add(rank);
    seenNames.add(name.toLowerCase());
    rankings.push({ rank, name, normalizedName: normalizeName(name), type });
  }

  console.log(`[PL] numbered parser: ${rankings.length} ${type.toUpperCase()} entries`);
  return rankings.sort((a, b) => a.rank - b.rank);
}

// ── Parser B: RP closer-situation tables ──────────────────────────────────

function parseRPFromTables(html, maxRank) {
  const players   = [];
  const seenNames = new Set();

  const rowRe = /<tr(?:\s[^>]*)?>[\s\S]*?<\/tr>/gi;

  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[0];

    const playerRe = /href="https:\/\/pitcherlist\.com\/player\/[^"]*"[^>]*>([^<]+)<\/a>/i;
    const playerMatch = row.match(playerRe);
    if (!playerMatch) continue;

    const name = decodeHtmlEntities(playerMatch[1]).trim();
    if (!name || name.split(/\s+/).length < 2) continue;
    if (/^(pitcher|role|save|name|rank)$/i.test(name)) continue;
    if (seenNames.has(name.toLowerCase())) continue;

    const pctMatch = row.match(/(\d+)%/);
    const pct = pctMatch ? parseInt(pctMatch[1], 10) : 0;

    seenNames.add(name.toLowerCase());
    players.push({ name, pct, docOrder: players.length });
  }

  if (players.length === 0) return [];

  players.sort((a, b) => b.pct - a.pct || a.docOrder - b.docOrder);

  return players.slice(0, maxRank).map((p, i) => ({
    rank:           i + 1,
    name:           p.name,
    normalizedName: normalizeName(p.name),
    type:           'rp',
    saveChancePct:  p.pct,
  }));
}


// ── Parser C: Prospect table ───────────────────────────────────────────────
//
// Format: <tr><td>RANK</td><td><a href="/player/...">Name</a></td><td>TEAM</td>...
// Used for the dynasty prospect list.

function parseProspectTable(html, maxRank) {
  const rankings  = [];
  const seenRanks = new Set();
  const seenNames = new Set();

  // Match table rows containing a /player/ link
  const rowRe = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];

    // First td must be a plain rank number
    const rankMatch = row.match(/<td[^>]*>\s*(\d{1,3})\s*<\/td>/);
    if (!rankMatch) continue;
    const rank = parseInt(rankMatch[1], 10);
    if (rank < 1 || rank > maxRank) continue;
    if (seenRanks.has(rank)) continue;

    // Second td must contain a /player/ link
    const nameMatch = row.match(/href="https:\/\/pitcherlist\.com\/player\/[^"]*"[^>]*>([^<]+)<\/a>/);
    if (!nameMatch) continue;

    const name = decodeHtmlEntities(nameMatch[1]).trim();
    if (!name || name.split(/\s+/).length < 2) continue;
    if (seenNames.has(name.toLowerCase())) continue;

    seenRanks.add(rank);
    seenNames.add(name.toLowerCase());
    rankings.push({ rank, name, normalizedName: normalizeName(name), type: 'prospect' });
  }

  console.log(`[PL] prospect table parser: ${rankings.length} entries`);
  return rankings.sort((a, b) => a.rank - b.rank);
}


// ── Parser D: Sit/Start matchup tables ────────────────────────────────────
//
// Article tables: | Date | Game | Away Pitcher | Sit/Start | Home Pitcher | Sit/Start |
// Ratings: "Start-9", "Maybe-5", "Sit-2"
// Pitcher names are abbreviated: "P. Skenes", "M. Fried"

function parseSitStart(html) {
  const results = [];
  const seen    = new Set();

  // Strip all tags from a cell's inner HTML
  function cellText(inner) {
    return decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
  }

  // Each matchup row has 6 <td>s: Date | Game | Away Pitcher | Rating | Home Pitcher | Rating
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row   = rowMatch[1];
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(row)) !== null) {
      cells.push(cellText(cellMatch[1]));
    }
    if (cells.length < 6) continue;

    for (const [nameRaw, ratingRaw] of [[cells[2], cells[3]], [cells[4], cells[5]]]) {
      const name   = nameRaw.replace(/[*_]/g, '').trim();
      const rating = ratingRaw.replace(/[*_]/g, '').trim();
      if (!name || name.length < 3) continue;

      const ratingMatch = rating.match(/(Start|Maybe|Sit)[- ](\d+)/i);
      if (!ratingMatch) continue;

      const label = ratingMatch[1].charAt(0).toUpperCase() + ratingMatch[1].slice(1).toLowerCase();
      const score = parseInt(ratingMatch[2], 10);
      const norm  = normalizeName(name);
      if (seen.has(norm)) continue;
      seen.add(norm);

      results.push({ rank: score, name, normalizedName: norm, type: 'sitstart', label, score });
    }
  }

  console.log(`[PL] Sit/Start parser: ${results.length} entries`);
  return results;
}


// ── Parser E: Plain-text numbered list ────────────────────────────────────
//
// Format: "10. Corbin Carroll (OF, ARI) —" or "10. Carlos Correa (SS, HOU)"
// Used by Top 300 Hitters and similar preseason articles where names are
// not wrapped in <strong> or player-link anchors.

function parsePlainNumberedList(html, maxRank) {
  const rankings  = [];
  const seenRanks = new Set();
  const seenNames = new Set();

  // html is already pre-sliced to article body by the caller — just decode and strip
  let text = html
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&rsquo;/g, "'").replace(/&ndash;/g, '–').replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

  // Match "10. Corbin Carroll (OF, ARI)" or "10. Corbin Carroll —" or "10. Corbin Carroll –"
  // Name can be 2-4 words, possibly including "De La" etc.
  // Match "N. Name (" or "N. Name —" or "N. Name –" — handles both preseason and weekly formats
  // Also handles "Jr." and "Sr." in names via [a-z'.\-]+
  const re = /\b(\d{1,3})\. ([A-Z][a-z'\-]+ (?:[A-Z][a-z'.\-]+ ?){1,2})[\(\u2013\u2014]/g;
  let m;

  while ((m = re.exec(text)) !== null) {
    const rank = parseInt(m[1], 10);
    if (rank < 1 || rank > maxRank) continue;
    if (seenRanks.has(rank)) continue;

    const name = m[2].trim();
    if (!name.includes(' ')) continue;
    if (/^(The|This|That|These|For|With|From|When|What|How|His|Her|Their|Top|All|After|Before|While|Since|Updated|Note|Nate)/.test(name)) continue;

    const norm = normalizeName(name);
    if (seenNames.has(norm)) continue;

    seenRanks.add(rank);
    seenNames.add(norm);
    rankings.push({ rank, name, normalizedName: norm, type: 'h' });
  }

  console.log(`[PL] plain-text list parser: ${rankings.length} entries`);
  return rankings.sort((a, b) => a.rank - b.rank);
}


// ── Parser F: Hitter table (ranks 151-300) ────────────────────────────────
//
// Format: <tr><td>15</td><td>156</td><td>Jung Hoo Lee</td><td>OF</td><td>SFG</td></tr>
// Columns: Tier | Rank | Name | Position | Team

function parseHitterTable(html, maxRank) {
  const results = [];
  const seen    = new Set();

  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row     = rowMatch[1];
    const cellRe  = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells   = [];
    let cellMatch;
    while ((cellMatch = cellRe.exec(row)) !== null) {
      cells.push(cellMatch[1].replace(/<[^>]+>/g, '').trim());
    }

    // Need at least 5 cells: Tier | Rank | Name | Position | Team
    if (cells.length < 5) continue;

    // cells[0] = tier (number), cells[1] = rank (number), cells[2] = name
    const tier = parseInt(cells[0], 10);
    const rank = parseInt(cells[1], 10);
    const name = decodeHtmlEntities(cells[2]).trim();

    if (isNaN(tier) || isNaN(rank)) continue;
    if (rank < 1 || rank > maxRank) continue;
    if (!name || name.split(' ').length < 2) continue;

    const norm = normalizeName(name);
    if (seen.has(norm)) continue;
    seen.add(norm);

    results.push({ rank, name, normalizedName: norm, type: 'h' });
  }

  console.log(`[PL] hitter table parser: ${results.length} entries`);
  return results;
}


// ── Parser G: Weekly hitter table (PL in-season format) ───────────────────
//
// Format: <tr><td class="rank">1</td><td class="name"><a href="...">Name</a>...
// Used by weekly Top 150 hitter articles

function parseWeeklyHitterTable(html, maxRank) {
  const results = [];
  const seen    = new Set();

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const row = rowMatch[1];

    const rankMatch = row.match(/<td[^>]*class="[^"]*rank[^"]*"[^>]*>(\d+)<\/td>/i);
    const nameMatch = row.match(/<td[^>]*class="[^"]*name[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i);

    if (!rankMatch || !nameMatch) continue;

    const rank = parseInt(rankMatch[1], 10);
    if (rank < 1 || rank > maxRank) continue;

    const name = decodeHtmlEntities(nameMatch[1].trim());
    if (!name || !name.includes(' ')) continue;

    const norm = normalizeName(name);
    if (seen.has(norm)) continue;
    seen.add(norm);

    results.push({ rank, name, normalizedName: norm, type: 'h' });
  }

  console.log(`[PL] weekly hitter table parser: ${results.length} entries`);
  return results.sort((a, b) => a.rank - b.rank);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g,  '&').replace(/&lt;/g,   '<').replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/gi,       (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z]{2,8};/gi,   ' ');
}

function normalizeName(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s'.\-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
