# Sync Architecture - Split Quick/Full Approach

## Problem Solved

The original `/api/sync/live-gameweek` endpoint was timing out because it tried to sync **ALL 700+ players** every hour, which took >60 seconds (exceeds Vercel's free tier limit).

## Solution: Split into Quick + Full Syncs

### Quick Sync (Hourly) ⚡
**Endpoint:** `/api/sync/quick-stats`
- Syncs only ~220 players who played in the **last 2 gameweeks**
- Completes in **~20 seconds** (well under 30s limit)
- Run by GitHub Actions **every hour**
- Keeps recent data fresh for active gameweeks

### Full Sync (Weekly) 🔄
**Endpoint:** `/api/sync/full-stats`
- Syncs **ALL 700+ players** for complete historical data
- Takes **60-120 seconds** (fire-and-forget via GitHub Actions)
- Run by GitHub Actions **weekly on Sundays at 3 AM UTC**
- Backfills any missing data and ensures complete records

## Data Flow

```
FPL API (element-summary)
         ↓
   Sync Endpoints (quick or full)
         ↓
player_gameweek_stats table
  (xG, xGC, goals, assists, etc.)
         ↓
SQL Functions (get_team_xg_stats, etc.)
  (aggregate player stats → team totals)
         ↓
    Teams Page (React)
  (loads from Supabase instantly)
```

## GitHub Actions Workflows

### 1. Hourly Quick Sync
**File:** `.github/workflows/hourly-sync.yml`
- **Schedule:** Every hour (`0 * * * *`)
- **Triggers:** `/api/sync/trigger` → `/api/sync/quick-stats` + `/api/fdr/calculate`
- **Duration:** 2-30 seconds
- **Manual trigger:** Go to Actions → "Hourly Quick Sync" → Run workflow

### 2. Weekly Full Sync
**File:** `.github/workflows/weekly-full-sync.yml`
- **Schedule:** Sundays at 3 AM UTC (`0 3 * * 0`)
- **Triggers:** `/api/sync/full-stats`
- **Duration:** 60-120 seconds (fire-and-forget)
- **Manual trigger:** Go to Actions → "Weekly Full Data Sync" → Run workflow

## Endpoints Reference

### `/api/sync/trigger` (Main entry point)
- Called by GitHub Actions hourly
- Orchestrates: quick-stats → fdr/calculate
- Auth: `ADMIN_TOKEN`

### `/api/sync/quick-stats` (NEW)
- Syncs recent players only (~220 players, last 2 GWs)
- Fast: ~20 seconds
- Auth: `ADMIN_TOKEN`

### `/api/sync/full-stats` (NEW)
- Syncs all players (~700 players, all GWs)
- Slow: 60-120 seconds
- Auth: `ADMIN_TOKEN`

### `/api/sync/live-gameweek` (DEPRECATED)
- Old endpoint - timed out with 700 players
- Keep for reference but no longer used

### `/api/fdr/calculate`
- Calculates FDR ratings from player_gameweek_stats
- Already has staleness checking (skips if <1 hour old)
- Auth: `ADMIN_TOKEN`

## Why This Works

1. **Quick sync keeps data fresh** - Most important data (recent games) updates hourly
2. **Full sync prevents gaps** - Weekly backfill ensures no missing historical data
3. **No timeouts** - Quick sync completes in 20s, well under 30s limit
4. **Fire-and-forget** - GitHub Actions doesn't wait for completion, sync continues on Vercel
5. **Free tier compatible** - No Vercel cron (Pro plan) needed
6. **xG data included** - Both syncs fetch full player data including expected goals

## Monitoring

**Check if syncs are working:**

1. **GitHub Actions logs:**
   - https://github.com/attrill20/FPLServer/actions
   - Look for green checkmarks on workflows

2. **Vercel function logs:**
   - https://vercel.com/attrill20s-projects/fpl-server-dbly/logs
   - Filter by `/api/sync/quick-stats` or `/api/sync/full-stats`

3. **Data freshness:**
   ```bash
   curl -s "https://fpl-server-nine.vercel.app/api/fdr/ratings" | grep updated_at
   ```
   Should show timestamp within last ~1 hour

## Manual Triggers

**Quick sync (anytime):**
```bash
curl -X POST https://fpl-server-nine.vercel.app/api/sync/trigger \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Full sync (for backfill):**
```bash
curl -X POST https://fpl-server-nine.vercel.app/api/sync/full-stats \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## Future Improvements

- Add Vercel Pro plan → increase timeout limits → can make quick sync even more comprehensive
- Add real-time websocket updates during live matches
- Cache FPL API responses to reduce rate limit pressure
- Add sync status dashboard to frontend
