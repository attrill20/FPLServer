/**
 * POST /api/mid-season-update/generate
 *
 * Checks if it's an international break weekend (no PL fixtures Sat/Sun)
 * and generates a mid-season FDR update post if conditions are met.
 * Protected endpoint - requires ADMIN_TOKEN or CRON_SECRET.
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-cron-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security check
  const authHeader = req.headers.authorization;
  const cronSecret = req.headers['x-vercel-cron-secret'];

  const isAuthorized =
    authHeader === `Bearer ${process.env.ADMIN_TOKEN}` ||
    cronSecret === process.env.CRON_SECRET;

  if (!isAuthorized) {
    console.error('Unauthorized mid-season update attempt');
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  console.log('Starting mid-season update check...');

  try {
    // Step 1: Check for weekend fixtures (Saturday/Sunday)
    const now = new Date();
    const saturday = new Date(now);
    saturday.setDate(now.getDate() - now.getDay() + 6); // This Saturday
    saturday.setHours(0, 0, 0, 0);
    const monday = new Date(saturday);
    monday.setDate(saturday.getDate() + 2); // Monday after
    monday.setHours(0, 0, 0, 0);

    console.log(`  Checking for fixtures between ${saturday.toISOString()} and ${monday.toISOString()}`);

    const fplResponse = await fetch('https://fantasy.premierleague.com/api/fixtures/');
    if (!fplResponse.ok) {
      throw new Error(`FPL API returned ${fplResponse.status}`);
    }
    const fixtures = await fplResponse.json();

    const weekendFixtures = fixtures.filter(f => {
      if (!f.kickoff_time) return false;
      const ko = new Date(f.kickoff_time);
      return ko >= saturday && ko < monday;
    });

    if (weekendFixtures.length > 0) {
      console.log(`  Found ${weekendFixtures.length} weekend fixtures - skipping`);
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: `${weekendFixtures.length} fixtures found this weekend`
      });
    }

    console.log('  No weekend fixtures found - international break detected');

    // Step 2: Get current season
    const { data: currentSeason, error: seasonError } = await supabase
      .from('seasons')
      .select('id')
      .eq('is_current', true)
      .single();

    if (seasonError || !currentSeason) {
      throw new Error(`Could not get current season: ${seasonError?.message || 'not found'}`);
    }

    // Step 3: Check 30-day cooldown
    const { data: lastUpdate } = await supabase
      .from('mid_season_updates')
      .select('id, created_at, current_gameweek_id')
      .eq('season_id', currentSeason.id)
      .order('created_at', { ascending: false })
      .limit(1);

    if (lastUpdate && lastUpdate.length > 0) {
      const daysSince = (now - new Date(lastUpdate[0].created_at)) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        console.log(`  Last update was ${daysSince.toFixed(1)} days ago - cooldown active`);
        return res.status(200).json({
          success: true,
          skipped: true,
          reason: `Last update was ${daysSince.toFixed(1)} days ago (30-day cooldown)`
        });
      }
    }

    // Step 4: Determine current GW (most recent finished)
    const { data: currentGWData, error: gwError } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('finished', true)
      .order('id', { ascending: false })
      .limit(1);

    if (gwError || !currentGWData || currentGWData.length === 0) {
      console.log('  No finished gameweeks found - skipping');
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'No finished gameweeks found'
      });
    }

    const currentGW = currentGWData[0];

    // Step 5: Determine baseline GW
    let baselineGWId;
    if (lastUpdate && lastUpdate.length > 0) {
      baselineGWId = lastUpdate[0].current_gameweek_id;
    } else {
      // First update of season - use earliest GW with snapshot data
      const { data: earliestSnap } = await supabase
        .from('fdr_weekly_snapshots')
        .select('gameweek_id')
        .eq('season_id', currentSeason.id)
        .order('gameweek_id', { ascending: true })
        .limit(1);

      if (!earliestSnap || earliestSnap.length === 0) {
        console.log('  No snapshot data found - skipping');
        return res.status(200).json({
          success: true,
          skipped: true,
          reason: 'No FDR snapshot data available'
        });
      }
      baselineGWId = earliestSnap[0].gameweek_id;
    }

    // Skip if baseline and current are the same
    if (baselineGWId === currentGW.id) {
      console.log('  Baseline and current GW are the same - skipping');
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'No new gameweeks since last update'
      });
    }

    // Step 6: Validate snapshots exist for both GWs
    const [{ data: baselineSnaps }, { data: currentSnaps }] = await Promise.all([
      supabase
        .from('fdr_weekly_snapshots')
        .select('id')
        .eq('gameweek_id', baselineGWId)
        .limit(1),
      supabase
        .from('fdr_weekly_snapshots')
        .select('id')
        .eq('gameweek_id', currentGW.id)
        .limit(1)
    ]);

    if (!baselineSnaps?.length || !currentSnaps?.length) {
      console.log('  Missing snapshot data for baseline or current GW - skipping');
      return res.status(200).json({
        success: true,
        skipped: true,
        reason: 'Missing FDR snapshots for comparison'
      });
    }

    // Step 7: Get baseline GW info for gameweeks_elapsed calculation
    const { data: baselineGW } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('id', baselineGWId)
      .single();

    const baselineGWNumber = parseInt(baselineGW.name.replace(/\D/g, '')) || 0;
    const currentGWNumber = parseInt(currentGW.name.replace(/\D/g, '')) || 0;
    const gameweeksElapsed = currentGWNumber - baselineGWNumber;

    // Step 8: Find next fixture date from FPL API
    let nextFixtureDate = null;
    const futureFixtures = fixtures
      .filter(f => f.kickoff_time && new Date(f.kickoff_time) > now)
      .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));

    if (futureFixtures.length > 0) {
      nextFixtureDate = futureFixtures[0].kickoff_time;
    }

    // Step 9: Insert mid-season update
    const { data: inserted, error: insertError } = await supabase
      .from('mid_season_updates')
      .insert({
        season_id: currentSeason.id,
        baseline_gameweek_id: baselineGWId,
        current_gameweek_id: currentGW.id,
        gameweeks_elapsed: gameweeksElapsed,
        next_fixture_date: nextFixtureDate
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to insert mid-season update: ${insertError.message}`);
    }

    console.log(`  Mid-season update created: GW${baselineGWNumber} -> GW${currentGWNumber} (${gameweeksElapsed} GWs elapsed)`);
    console.log(`  Next fixture: ${nextFixtureDate || 'unknown'}`);

    return res.status(200).json({
      success: true,
      skipped: false,
      update: {
        id: inserted.id,
        baseline: baselineGW.name,
        current: currentGW.name,
        gameweeks_elapsed: gameweeksElapsed,
        next_fixture_date: nextFixtureDate
      }
    });

  } catch (error) {
    console.error('Mid-season update check failed:', error);
    return res.status(500).json({
      success: false,
      error: 'Mid-season update check failed',
      message: error.message
    });
  }
}

export const config = {
  maxDuration: 30,
};
