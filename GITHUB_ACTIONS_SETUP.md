# GitHub Actions Cron Setup

## Why GitHub Actions Instead of Vercel Cron?

Vercel cron jobs require a Pro plan ($20/month). GitHub Actions provides free scheduled workflows that can trigger your API endpoints.

## What This Does

The `.github/workflows/hourly-sync.yml` workflow:
- Runs every hour at the top of the hour (`:00`)
- Calls `/api/sync/trigger` which:
  - Syncs live gameweek data from FPL API
  - Recalculates FDR ratings
  - Auto-advances gameweek when current GW finishes

## Setup Instructions

### 1. Add GitHub Secret

You need to add your `ADMIN_TOKEN` as a GitHub repository secret:

1. Go to your GitHub repository: https://github.com/attrill20/FPLServer
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Name: `ADMIN_TOKEN`
5. Value: Your admin token (same value as in Vercel environment variables)
6. Click **Add secret**

### 2. Verify It's Working

After pushing this workflow file:

1. Go to **Actions** tab in your GitHub repo
2. You should see "Hourly FPL Data Sync" workflow
3. It will run automatically every hour
4. You can also click **Run workflow** to test it manually

### 3. Check Logs

To see if syncs are working:
- Go to **Actions** tab
- Click on any workflow run
- Expand the steps to see logs

## Manual Triggering

You can manually trigger the sync anytime:
1. Go to **Actions** tab
2. Select "Hourly FPL Data Sync"
3. Click **Run workflow** → **Run workflow**

## Notes

- GitHub Actions is free for public repositories
- Free tier includes 2,000 minutes/month (more than enough for hourly 10-second pings)
- The workflow only triggers your API endpoint - the actual work happens on Vercel
