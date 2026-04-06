'use strict';

document.addEventListener('DOMContentLoaded', () => {
  loadCacheState();

  document.getElementById('sync-draft-btn').addEventListener('click', () => {
    const btn = document.getElementById('sync-draft-btn');
    btn.disabled    = true;
    btn.innerHTML   = '<span class="btn-icon spinning">↻</span> Syncing…';

    // League ID hardcoded to John's ESPN league
    chrome.runtime.sendMessage({ type: 'SYNC_DRAFT_PRICES', leagueId: 188796 }, (res) => {
      btn.disabled  = false;
      btn.innerHTML = '<span class="btn-icon">💰</span> Sync Draft Prices';

      if (res?.error) {
        showStatus(`Error: ${res.error}`, 'error');
      } else if (res?.ok) {
        showStatus(`Synced! ${res.drafted} drafted · ${res.pickups} pickups ($1)`, 'success');
      }
    });
  });

  document.getElementById('refresh-btn').addEventListener('click', () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon spinning">↻</span> Refreshing…';

    chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, () => {
      loadCacheState();
      btn.disabled = false;
      btn.innerHTML = '<span class="btn-icon">↻</span> Refresh Rankings';
      showStatus('Rankings updated!', 'success');
    });
  });
});

function loadCacheState() {
  chrome.runtime.sendMessage({ type: 'GET_RANKINGS' }, (data) => {
    if (chrome.runtime.lastError) {
      showStatus('Could not reach background worker.', 'error');
      return;
    }

    if (!data) {
      setEl('sp-count', '—');
      setEl('rp-count', '—');
      setEl('last-updated', 'Never — click Refresh');
      return;
    }

    // Counts
    const spCount = data.sp?.length ?? 0;
    const hCount        = data.h?.length        ?? 0;
    const prospectCount = data.prospect?.length ?? 0;
    const rpCount = data.rp?.length ?? 0;
    setEl('sp-count', spCount > 0 ? `${spCount} pitchers` : 'None');
    setEl('rp-count', rpCount > 0 ? `${rpCount} pitchers` : 'None');
    setEl('h-count',        hCount        > 0 ? `${hCount} hitters`     : 'None');
    setEl('prospect-count', prospectCount > 0 ? `${prospectCount} prospects` : 'None');

    // Last updated
    if (data.fetchedAt) {
      setEl('last-updated', formatRelativeTime(data.fetchedAt));
    }

    // Article links
    const spUrl = data.sp?.[0]?.articleUrl;
    const rpUrl = data.rp?.[0]?.articleUrl;
    if (spUrl || rpUrl) {
      const linksSection = document.getElementById('article-links');
      linksSection.classList.remove('hidden');
      if (spUrl) document.getElementById('sp-link').href = spUrl;
      if (rpUrl) document.getElementById('rp-link').href = rpUrl;
    }

    // Errors
    if (data.errors && Object.keys(data.errors).length > 0) {
      const errBanner = document.getElementById('error-banner');
      errBanner.classList.remove('hidden');
      errBanner.innerHTML = Object.entries(data.errors)
        .map(([k, v]) => `<span>⚠️ ${k.toUpperCase()}: ${v}</span>`)
        .join('');
    } else {
      document.getElementById('error-banner').classList.add('hidden');
    }
  });
}

function formatRelativeTime(ts) {
  const diffMs   = Date.now() - ts;
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHrs  = Math.floor(diffMins / 60);

  if (diffMins < 1)  return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs  < 24) return `${diffHrs}h ago`;

  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function showStatus(msg, type = 'success') {
  const el = document.getElementById('status-msg');
  el.textContent  = msg;
  el.className    = `status-msg status-${type}`;
  setTimeout(() => {
    el.textContent = '';
    el.className   = 'status-msg';
  }, 3000);
}

function setEl(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
