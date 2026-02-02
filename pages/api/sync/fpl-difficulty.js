/**
 * POST /api/sync/fpl-difficulty
 *
 * Syncs FPL official difficulty ratings from fixtures to teams table
 * Run this periodically to keep FPL ratings fresh
 *
 * Security: Protected by ADMIN_TOKEN or CRON_SECRET
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FPL_API_BASE = 'https://fantasy.premierleague.com/api';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    console.error('❌ Unauthorized FPL difficulty sync attempt');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  console.log('🎯 Starting FPL difficulty sync...');
  const startTime = Date.now();

  try {
    // Fetch fixtures from FPL API with browser-like headers to avoid 403
    const fixturesResponse = await fetch(`${FPL_API_BASE}/fixtures/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://fantasy.premierleague.com/',
        'Origin': 'https://fantasy.premierleague.com'
      }
    });
    if (!fixturesResponse.ok) {
      throw new Error(`FPL API error: ${fixturesResponse.status}`);
    }
    const fixtures = await fixturesResponse.json();

    console.log(`  → Fetched ${fixtures.length} fixtures`);

    // Build FPL difficulty ratings for each team
    const teamDifficulties = {};

    fixtures.forEach(fixture => {
      if (!fixture.team_h_difficulty || !fixture.team_a_difficulty) return;

      // Initialize team if not exists
      if (!teamDifficulties[fixture.team_h]) {
        teamDifficulties[fixture.team_h] = { home: null, away: null };
      }
      if (!teamDifficulties[fixture.team_a]) {
        teamDifficulties[fixture.team_a] = { home: null, away: null };
      }

      // Store first occurrence - CORRECTED LOGIC:
      // team_h_difficulty = difficulty FOR home team (i.e., away team's strength)
      // team_a_difficulty = difficulty FOR away team (i.e., home team's strength)
      // So to get each team's inherent difficulty:
      //   - Home team's home difficulty = team_a_difficulty (how hard for away team)
      //   - Away team's away difficulty = team_h_difficulty (how hard for home team)
      if (teamDifficulties[fixture.team_h].home === null) {
        teamDifficulties[fixture.team_h].home = fixture.team_a_difficulty;
      }
      if (teamDifficulties[fixture.team_a].away === null) {
        teamDifficulties[fixture.team_a].away = fixture.team_h_difficulty;
      }
    });

    console.log(`  → Calculated difficulties for ${Object.keys(teamDifficulties).length} teams`);

    // Update teams table with FPL difficulties
    let updated = 0;
    let errors = 0;

    for (const [teamId, diffs] of Object.entries(teamDifficulties)) {
      const { error } = await supabase
        .from('teams')
        .update({
          fpl_home_difficulty: diffs.home || 3,
          fpl_away_difficulty: diffs.away || 3,
          updated_at: new Date().toISOString()
        })
        .eq('id', parseInt(teamId));

      if (error) {
        console.error(`  ✗ Failed to update team ${teamId}:`, error.message);
        errors++;
      } else {
        updated++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ FPL difficulty sync complete in ${duration}s`);
    console.log(`   Teams updated: ${updated}`);
    console.log(`   Errors: ${errors}`);

    return res.status(200).json({
      success: true,
      message: 'FPL difficulty ratings synced successfully',
      stats: {
        teams_updated: updated,
        errors,
        duration_seconds: parseFloat(duration)
      }
    });

  } catch (error) {
    console.error('❌ FPL difficulty sync failed:', error);

    return res.status(500).json({
      success: false,
      error: 'FPL difficulty sync failed',
      message: error.message
    });
  }
}

export const config = {
  maxDuration: 30,
};
