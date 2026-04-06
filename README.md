# PitcherList Rank Overlay — Chrome Extension

Injects PitcherList SP and RP rankings directly into ESPN Fantasy Baseball
free agent pages so you can see Nick Pollack's rankings without switching tabs.

---

## What it shows

| Badge color | Source          | Covers           |
|-------------|-----------------|------------------|
| 🔵 Blue     | The List (SP)   | Top ~135 starters |
| 🟢 Green    | Closing Time (RP) | Top ~40 relievers |
| 🟡 Gold     | Either          | Top 10 in category |

Hovering any badge shows a tooltip: `PitcherList SP Rank #12 — Logan Webb`

---

## Installation

1. Download / unzip this folder
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (toggle, top-right)
4. Click **Load unpacked** → select the `pl-espn-extension` folder
5. Navigate to any ESPN Fantasy Baseball page — badges load automatically

On first install the extension immediately fetches the latest rankings.
After that it auto-refreshes every 24 hours.

---

## Usage

### Viewing ranks
Go to your ESPN Fantasy Baseball league → **Free Agents** → filter to **P**
(pitchers). You'll see rank badges inline next to every pitcher on The List or
Closing Time.

Works on:
- Free Agents / Players add page
- Player detail pages
- Trade / lineup pages (anywhere ESPN renders a player link)

### Popup (click the extension icon)
- SP & RP count + last-updated timestamp
- **Refresh Rankings** button to force an immediate re-fetch
- Links to the current List / Closing Time article

---

## How name matching works

Matching priority (highest → lowest confidence):

1. **URL slug** — ESPN's player links contain slugs like `/paul-skenes`.
   This normalizes to "paul skenes" and is matched exactly against PitcherList.
   Handles diacritics automatically (José → jose).

2. **Full display name** — "Paul Skenes" matched after normalization.

3. **F. Lastname abbreviation** — ESPN uses "P. Skenes" in tight views;
   the extension resolves via first-initial + last-name lookup.

4. **Last-name fallback** — only fires when the last name is unique on the list.

---

## Troubleshooting

**No badges appearing**
- Open the popup and click Refresh Rankings
- Check the popup for any error messages (network issues, parse failures)
- Verify you're on `fantasy.espn.com/baseball/*`

**Wrong rank shown**
- This happens most often with players who share a last name
- The URL slug match should prevent most false positives
- Open an issue or submit a PR with the specific case

**Rankings feel stale**
- Click Refresh in the popup to force an immediate re-fetch
- The extension caches aggressively to avoid hammering pitcherlist.com

---

## File structure

```
pl-espn-extension/
├── manifest.json     # Chrome Extension Manifest V3
├── background.js     # Service worker: fetch + cache rankings
├── content.js        # ESPN DOM injection
├── content.css       # Badge styles
├── popup.html        # Extension popup UI
├── popup.js          # Popup logic
├── popup.css         # Popup styles
└── icons/            # Extension icons
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Data sources

- **SP**: [The List](https://pitcherlist.com/category/fantasy/starting-pitchers/the-list/) by Nick Pollack
- **RP**: [Closing Time](https://pitcherlist.com/category/fantasy/relief-pitchers/closing-time/) by PitcherList

Rankings are fetched directly from the public PitcherList articles.
No API key required.
