/**
 * content.js — PitcherList Rank Overlay
 * ESPN (fantasy.espn.com) + Yahoo (baseball.fantasysports.yahoo.com)
 *
 * Badge types:
 *   sp       → blue    (#2563eb)
 *   rp       → green   (#16a34a)
 *   h        → purple  (#7c3aed)
 *   prospect → orange  (#ea580c) ★ prefix, italic
 *
 * Rank delta: shown inline with badge — ↑3 green / ↓2 red / NEW label
 *
 * Keeper tags (ESPN only): user-defined $price stored in chrome.storage.local
 */

(() => {
  'use strict';

  const BADGE_CLASS      = 'pl-rank-badge';
  const DELTA_CLASS      = 'pl-rank-delta';
  const KEEPER_CLASS     = 'pl-keeper-badge';
  const FILTER_BTN_ID    = 'pl-filter-btn';
  const TEAM_TOGGLE_ID   = 'pl-team-toggle-btn';
  const HIDDEN_ROW_CLASS = 'pl-row-hidden';
  const RANKS_HIDDEN_CLS = 'pl-ranks-hidden';
  const KEEPER_STORE_KEY = 'plKeepers';

  const IS_YAHOO = location.hostname.includes('yahoo.com');

  // ── Team page detection ────────────────────────────────────────────────────

  function isTeamPage() {
    const path = location.pathname;
    if (!IS_YAHOO) return path.includes('/baseball/team');
    return /\/b1\/\d+\/team/.test(path) || /\/b1\/\d+\/\d+/.test(path);
  }

  const ON_TEAM_PAGE = isTeamPage();

  let exactMap    = null;
  let lastNameMap = null;
  let prevRankMap = null; // normalizedName:type → prevRank
  let sitStartMap = null; // normalizedName → { label, score }
  let keeperMap   = {};   // normalizedName → { price, displayName }
  let filterActive = false;
  let ranksVisible = !ON_TEAM_PAGE;

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  // Load keepers from storage first, then rankings
  chrome.storage.local.get(KEEPER_STORE_KEY, (res) => {
    keeperMap = res[KEEPER_STORE_KEY] ?? {};

    chrome.runtime.sendMessage({ type: 'GET_RANKINGS' }, (data) => {
      if (chrome.runtime.lastError) {
        console.warn('[PL]', chrome.runtime.lastError.message);
        return;
      }
      if (!data || (!data.sp?.length && !data.rp?.length && !data.h?.length && !data.prospect?.length)) {
        console.info('[PL] No rankings cached — open popup and click Refresh Rankings.');
        return;
      }

      console.log(`[PL] SP:${data.sp?.length} RP:${data.rp?.length} H:${data.h?.length} Prospects:${data.prospect?.length} Sit/Start:${data.sitstart?.length} | team:${ON_TEAM_PAGE}`);
      buildLookupMaps(data);

      if (ON_TEAM_PAGE) document.body.classList.add(RANKS_HIDDEN_CLS);

      startPopupObserver();
      injectAll();
      tryInjectTeamToggle();

      if (!ON_TEAM_PAGE) {
      injectFilterButton();
      }

      const observer = new MutationObserver(debounce(() => {
        injectAll();
        tryInjectTeamToggle();
        if (!ON_TEAM_PAGE) {
          injectFilterButton();
          if (filterActive) applyFilter();
        }
      }, 400));
      observer.observe(document.body, { childList: true, subtree: true });
    });
  });

  // ── Lookup maps ────────────────────────────────────────────────────────────

  function buildLookupMaps(data) {
    exactMap    = new Map();
    lastNameMap = new Map();
    prevRankMap = new Map();

    // Build prev rank map: key = `${normalizedName}:${type}`
    for (const [type, list] of [
      ['sp', data.prevSp ?? []],
      ['rp', data.prevRp ?? []],
      ['h',  data.prevH  ?? []],
      ['prospect', data.prevProspect ?? []],
    ]) {
      for (const entry of list) {
        prevRankMap.set(`${entry.normalizedName}:${type}`, entry.rank);
      }
    }

    // Build sit/start map — keyed by normalizedName
    sitStartMap = new Map();
    for (const entry of (data.sitstart ?? [])) {
      sitStartMap.set(entry.normalizedName, entry);
      // Also index by last name for abbreviated name fallback
      const parts    = entry.normalizedName.split(' ');
      const lastName = parts[parts.length - 1];
      if (!sitStartMap.has(lastName)) sitStartMap.set(lastName, entry);
    }

    const all = [
      ...(data.sp       ?? []),
      ...(data.rp       ?? []),
      ...(data.h        ?? []),
      ...(data.prospect ?? []),
    ];

    for (const entry of all) {
      if (!exactMap.has(entry.normalizedName)) {
        exactMap.set(entry.normalizedName, entry);
      }
      const parts    = entry.normalizedName.split(' ');
      const lastName = parts[parts.length - 1];
      if (!lastNameMap.has(lastName)) lastNameMap.set(lastName, []);
      lastNameMap.get(lastName).push(entry);
    }
  }

  // ── Platform injection ─────────────────────────────────────────────────────

  function injectAll() {
    if (!exactMap) return;
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach(b => b.remove());
    document.querySelectorAll(`.${DELTA_CLASS}`).forEach(d => d.remove());
    document.querySelectorAll('.pl-ss-badge').forEach(b => b.remove());
    IS_YAHOO ? injectYahoo() : injectESPN();
  }

  // ── ESPN ───────────────────────────────────────────────────────────────────

  function injectESPN() {
    const containers = document.querySelectorAll('div.player-column__athlete[title]');
    let injected = 0;

    for (const el of containers) {
      const rawName = el.getAttribute('title');
      if (!rawName || rawName.length < 3) continue;

      const posEl     = el.closest('.player-column__bio')?.querySelector('.playerinfo__playerpos')
                     ?? el.parentElement?.querySelector('.playerinfo__playerpos');
      const pos       = posEl ? posEl.textContent.toUpperCase() : '';
      const isPitcher = pos.includes('SP') || pos.includes('RP') || pos.includes('P');
      const isHitter  = (pos && !isPitcher) || pos.includes('DH') || pos.includes('OF') || pos.includes('UT') || pos.includes('1B') || pos.includes('2B') || pos.includes('3B') || pos.includes('SS') || pos.includes('C');

      const entry = resolveEntry(rawName, isPitcher, isHitter);
      const norm  = normalizeName(rawName);

      // Keeper badge — show draft price if synced
      if (!el.querySelector(`.${KEEPER_CLASS}`) && keeperMap[norm]) {
        const kb = makeKeeperBadge(keeperMap[norm].price);
        const nameSpan = el.querySelector('span.truncate');
        nameSpan ? nameSpan.insertAdjacentElement('afterend', kb) : el.appendChild(kb);
      }

      // Sit/Start badge — team page only, pitchers only, only if starting today
      if (ON_TEAM_PAGE && isPitcher && sitStartMap) {
        const ssEntry = sitStartMap.get(norm)
                     ?? sitStartMap.get(norm.split(' ').pop());
        if (ssEntry && !el.querySelector('.pl-ss-badge')) {
          // Only show if this pitcher has a PP (Probable Pitcher) indicator
          const isProbable = !!el.querySelector('strong[title="Probable Pitcher"]');
          if (isProbable) {
            const ssBadge = makeSitStartBadge(ssEntry);
            const nameSpan = el.querySelector('span.truncate');
            nameSpan ? nameSpan.insertAdjacentElement('afterend', ssBadge) : el.appendChild(ssBadge);
          }
        }
      }

      if (!entry) continue;

      const badge    = makeBadge(entry, norm);
      const nameSpan = el.querySelector('span.truncate');
      nameSpan ? nameSpan.insertAdjacentElement('afterend', badge) : el.appendChild(badge);
      injected++;
    }

    if (injected > 0) console.log(`[PL] ESPN: ${injected} badges`);
  }

  // ── Yahoo ──────────────────────────────────────────────────────────────────

  function injectYahoo() {
    const anchors = document.querySelectorAll('a.name[title]');
    let injected = 0;

    for (const anchor of anchors) {
      const rawName = anchor.getAttribute('title');
      if (!rawName || rawName.length < 3) continue;

      const nameDiv = anchor.closest('.ysf-player-name');
      const posSpan = nameDiv?.querySelector('span.Fz-xxs');
      let pos = '';
      if (posSpan) {
        const posText = posSpan.textContent.trim();
        const dashIdx = posText.lastIndexOf(' - ');
        pos = dashIdx >= 0 ? posText.slice(dashIdx + 3).toUpperCase() : posText.toUpperCase();
      }

      const isPitcher = pos.includes('SP') || pos.includes('RP') || pos.includes('P');
      const isHitter  = (pos && !isPitcher) || pos.includes('DH') || pos.includes('OF') || pos.includes('UT') || pos.includes('1B') || pos.includes('2B') || pos.includes('3B') || pos.includes('SS') || pos.includes('C');

      // Sit/Start badge — team page only, SP only, only if probable starter today
      if (ON_TEAM_PAGE && isPitcher && sitStartMap) {
        const norm    = normalizeName(rawName);
        const ssEntry = sitStartMap.get(norm)
                     ?? sitStartMap.get(norm.split(' ').pop());
        if (ssEntry && !anchor.parentElement?.querySelector('.pl-ss-badge')) {
          // Yahoo probable starter: span[title="Probable Starter"] in .ysf-game-status
          const playerDiv  = anchor.closest('.Ta-start');
          const isProbable = !!playerDiv?.querySelector('span[title="Probable Starter"]');
          if (isProbable) {
            const ssBadge = makeSitStartBadge(ssEntry);
            anchor.insertAdjacentElement('afterend', ssBadge);
          }
        }
      }

      const entry = resolveEntry(rawName, isPitcher, isHitter);
      if (!entry) continue;

      const badge = makeBadge(entry, normalizeName(rawName));
      anchor.insertAdjacentElement('afterend', badge);
      injected++;
    }

    if (injected > 0) console.log(`[PL] Yahoo: ${injected} badges`);
  }

  // ── Badge creation ─────────────────────────────────────────────────────────

  function makeSitStartBadge(entry) {
    const badge = document.createElement('span');
    badge.className = 'pl-ss-badge';
    badge.setAttribute('data-ss-label', entry.label);

    const abbr = entry.label === 'Start' ? 'S' : entry.label === 'Maybe' ? 'M' : 'X';
    badge.textContent = `${abbr}-${entry.score}`;
    badge.title = `PitcherList Sit/Start: ${entry.label} ${entry.score} — ${entry.name}`;
    return badge;
  }

  function makeBadge(entry, norm) {
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.setAttribute('data-pl-type', entry.type);
    badge.setAttribute('data-pl-rank', String(entry.rank));

    // Compute tier for color coding (1=red top10, 2=orange, 3=amber, 4=yellow)
    let tier = 4;
    if (entry.rank <= 10) {
      tier = 1;
    } else if (entry.type === 'sp') {
      tier = entry.rank <= 20 ? 2 : entry.rank <= 50 ? 3 : 4;
    } else if (entry.type === 'rp') {
      tier = entry.rank <= 30 ? 2 : entry.rank <= 100 ? 3 : 4;
    } else if (entry.type === 'h') {
      tier = entry.rank <= 50 ? 2 : entry.rank <= 150 ? 3 : 4;
    }
    badge.setAttribute('data-pl-tier', String(tier));

    const prefix  = entry.type === 'prospect' ? '★ ' : '';
    const rankStr = `${prefix}#${entry.rank}`;

    // Rank delta
    const prevKey  = `${norm}:${entry.type}`;
    const prevRank = prevRankMap?.get(prevKey);
    let deltaEl    = null;

    if (prevRank != null) {
      const diff = prevRank - entry.rank; // positive = moved up
      if (diff !== 0) {
        deltaEl = document.createElement('span');
        deltaEl.className = `${DELTA_CLASS} ${diff > 0 ? 'pl-delta-up' : 'pl-delta-down'}`;
        deltaEl.textContent = diff > 0 ? `↑${diff}` : `↓${Math.abs(diff)}`;
      }
    } else if (prevRankMap?.size > 0) {
      // We have prev data but this player wasn't in it — they're new to the list
      deltaEl = document.createElement('span');
      deltaEl.className = `${DELTA_CLASS} pl-delta-new`;
      deltaEl.textContent = 'NEW';
    }

    if (deltaEl) {
      badge.textContent = rankStr + ' ';
      badge.appendChild(deltaEl);
    } else {
      badge.textContent = rankStr;
    }

    const typeLabel = entry.type === 'h' ? 'Hitter' : entry.type === 'prospect' ? 'Dynasty Prospect' : entry.type.toUpperCase();
    badge.title = `PitcherList ${typeLabel} #${entry.rank}${prevRank != null && prevRank !== entry.rank ? ` (was #${prevRank})` : ''} — ${entry.name}`;

    return badge;
  }

  // ── Keeper badge + button ──────────────────────────────────────────────────

  function makeKeeperBadge(price) {
    const badge = document.createElement('span');
    badge.className = KEEPER_CLASS;
    badge.textContent = `⭐ $${price}`;
    badge.title = `Keeper — $${price}`;
    return badge;
  }



  // ── Draft price sync button (ESPN free agent / team pages) ──────────────────

  // ── Auto-capture draft price from player popup ───────────────────────────
  // When ESPN renders a player popup, it contains text like:
  // "Drafted for $42 by Long Ball Larry"
  // We watch for popups opening and silently save the price.




  // ── Draft price capture from player popup ────────────────────────────────

  function tryCapture(root) {
    const nameEl = root.querySelector('.player-header .player-name');
    if (!nameEl) return;
    const parts = Array.from(nameEl.querySelectorAll(':scope > div'))
      .map(d => d.textContent.trim()).filter(Boolean);
    if (parts.length < 2) return;
    const rawName = parts.join(' ');
    const norm    = normalizeName(rawName);

    const txCells = root.querySelectorAll('[class*="transaction-details"]');
    for (const cell of txCells) {
      const match = cell.textContent.match(/Drafted\s+for\s+\$?(\d+)\s+by/i);
      if (!match) continue;
      const price = parseInt(match[1], 10);
      if (price < 1 || price > 260) continue;
      if (keeperMap[norm]?.price === price) return;
      keeperMap[norm] = { price, displayName: rawName };
      chrome.storage.local.set({ plKeepers: keeperMap }, () => {
        console.log(`[PL] Captured: ${rawName} $${price}`);
        injectAll();
        showCaptureToast(`⭐ $${price} — ${rawName}`);
      });
      return;
    }
  }

  function startPopupObserver() {
    if (IS_YAHOO) return;

    let captureTimer = null;

    function scheduleCapture() {
      clearInterval(captureTimer);
      let attempts = 0;
      captureTimer = setInterval(() => {
        attempts++;
        const card = document.querySelector('.player-card-center');
        if (!card) { clearInterval(captureTimer); return; }
        tryCapture(card);
        // Stop after 10 attempts (5s) or if already captured
        if (attempts >= 10) clearInterval(captureTimer);
      }, 500);
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('player-card-center') ||
              node.querySelector?.('.player-card-center')) {
            scheduleCapture();
            return;
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log('[PL] Popup observer active');
  }

  // ── Team page toggle ───────────────────────────────────────────────────────

  function tryInjectTeamToggle() {
    if (!ON_TEAM_PAGE) return;
    if (document.getElementById(TEAM_TOGGLE_ID)) return;

    const anchor = IS_YAHOO
      ? (document.querySelector('#full_stat_nav') ??
         document.querySelector('#team-roster header'))
      : (document.querySelector('.Nav__Secondary__Menu') ??
         document.querySelector('.players-table')        ??
         document.querySelector('.Table__Scroller')      ??
         document.querySelector('main'));

    if (!anchor) return;

    const btn = document.createElement('button');
    btn.id          = TEAM_TOGGLE_ID;
    btn.textContent = '⚾ Show PL Ranks';
    btn.title       = 'Toggle PitcherList rank badges on your roster';

    btn.addEventListener('click', () => {
      ranksVisible = !ranksVisible;
      btn.textContent = ranksVisible ? '⚾ Hide PL Ranks' : '⚾ Show PL Ranks';
      btn.classList.toggle('pl-filter-btn--active', ranksVisible);
      document.body.classList.toggle(RANKS_HIDDEN_CLS, !ranksVisible);
      if (ranksVisible) injectAll(); // re-inject in case ESPN re-rendered while hidden
    });

    anchor.insertAdjacentElement('beforebegin', btn);
  }

  // ── Filter button ──────────────────────────────────────────────────────────

  function injectFilterButton() {
    if (document.getElementById(FILTER_BTN_ID)) return;

    let toolbar = null;
    if (IS_YAHOO) {
      toolbar = document.querySelector('div.players') ?? document.querySelector('#playerForm');
    } else {
      toolbar = document.querySelector('.players-table__sortable')
             ?? document.querySelector('.fa-component-header')
             ?? document.querySelector('.jsx-1948381739');
    }
    if (!toolbar) return;

    const btn = document.createElement('button');
    btn.id          = FILTER_BTN_ID;
    btn.textContent = '⚾ PL Ranked Only';
    btn.title       = 'Show only PitcherList-ranked players, sorted by rank';

    btn.addEventListener('click', () => {
      filterActive = !filterActive;
      btn.classList.toggle('pl-filter-btn--active', filterActive);
      btn.textContent = filterActive ? '⚾ PL Ranked Only ✓' : '⚾ PL Ranked Only';
      applyFilter();
    });

    IS_YAHOO
      ? toolbar.insertAdjacentElement('beforebegin', btn)
      : toolbar.insertAdjacentElement('afterbegin', btn);
  }

  // ── Filter + sort ──────────────────────────────────────────────────────────

  function applyFilter() {
    const rowSelector = IS_YAHOO ? 'div.players tr' : 'tr.Table__TR';
    const rows = Array.from(document.querySelectorAll(rowSelector));

    if (!filterActive) {
      rows.forEach(row => {
        row.classList.remove(HIDDEN_ROW_CLASS);
        row.removeAttribute('data-pl-sort-rank');
      });
      return;
    }

    if (!IS_YAHOO) triggerESPNRankSort();

    rows.forEach(row => {
      const badge = row.querySelector(`.${BADGE_CLASS}`);
      if (badge) {
        row.setAttribute('data-pl-sort-rank', badge.getAttribute('data-pl-rank'));
        row.classList.remove(HIDDEN_ROW_CLASS);
      } else {
        row.removeAttribute('data-pl-sort-rank');
        row.classList.add(HIDDEN_ROW_CLASS);
      }
    });

    const tbodies = new Set(
      rows.filter(r => r.hasAttribute('data-pl-sort-rank')).map(r => r.parentElement).filter(Boolean)
    );
    for (const tbody of tbodies) {
      const rankedRows = Array.from(tbody.querySelectorAll('tr[data-pl-sort-rank]'));
      if (rankedRows.length < 2) continue;
      rankedRows.sort((a, b) =>
        parseInt(a.getAttribute('data-pl-sort-rank'), 10) -
        parseInt(b.getAttribute('data-pl-sort-rank'), 10)
      );
      rankedRows.forEach(row => tbody.appendChild(row));
    }
  }

  function triggerESPNRankSort() {
    const headers = document.querySelectorAll('th.Table__TH');
    for (const th of headers) {
      const link = th.querySelector('a[href*="sort=OR"]');
      if (!link) continue;
      if (th.classList.contains('Selected')) return;
      link.click();
      return;
    }
  }

  // ── Name resolution ────────────────────────────────────────────────────────

  function resolveEntry(displayName, isPitcher, isHitter) {
    const norm     = normalizeName(displayName);
    const parts    = norm.split(' ');
    const lastName = parts[parts.length - 1];
    const hits     = lastNameMap.get(lastName) ?? [];

    // Gather all entries matching this player regardless of type
    let candidates = [];
    if (exactMap.has(norm)) candidates.push(exactMap.get(norm));
    for (const e of hits) {
      if (e.normalizedName === norm && !candidates.includes(e)) candidates.push(e);
    }
    // Initial letter fallback (e.g. "S. Ohtani")
    if (candidates.length === 0 && parts.length >= 2 && parts[0].length === 1) {
      candidates = hits.filter(e => e.normalizedName.startsWith(parts[0]));
    }

    if (candidates.length === 0) return null;

    // If we confidently know the player's position context, filter candidates.
    // If the player is BOTH a pitcher and hitter (like combined Ohtani), we prioritize the best rank overall, or we can look at the active lineup slot if we knew it.
    // For now, if they match types, we filter for only the matched types.
    let typeMatched = candidates.filter(e => typeMatches(e.type, isPitcher, isHitter));
    
    // If we have an exact position match (e.g., they are only a pitcher), use only pitcher ranks.
    if (isPitcher && !isHitter) {
      typeMatched = candidates.filter(e => e.type === 'sp' || e.type === 'rp' || e.type === 'prospect');
    } else if (isHitter && !isPitcher) {
      typeMatched = candidates.filter(e => e.type === 'h' || e.type === 'prospect');
    }

    const pool = typeMatched.length > 0 ? typeMatched : candidates;
    return pool.reduce((best, e) => e.rank < best.rank ? e : best);
  }

  function typeMatches(entryType, isPitcher, isHitter) {
    if (!isPitcher && !isHitter) return true;
    if (isPitcher) return entryType === 'sp' || entryType === 'rp' || entryType === 'prospect';
    if (isHitter)  return entryType === 'h'  || entryType === 'prospect';
    return false;
  }

  function showCaptureToast(msg) {
    let toast = document.getElementById('pl-capture-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pl-capture-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function normalizeName(name) {
    return name
      .toLowerCase()
      .replace(/\(batter\)/g, '')
      .replace(/\(pitcher\)/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z\s'.\-]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }
})();
