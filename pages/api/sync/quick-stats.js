/**
 * API Endpoint: /api/sync/quick-stats
 *
 * QUICK SYNC: Only syncs players who played in the last 3 gameweeks
 * This catches missing recent data (e.g., GW 22 when we're on GW 23)
 * Syncs ~220-300 players instead of 700+, completes in <30 seconds
 *
 * Run this HOURLY via GitHub Actions
 *
 * For full historical backfill, use /api/sync/full-stats (run weekly)
 *
 * Security: Protected by ADMIN_TOKEN
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const FPL_API_BASE = 'https://fantasy.premierleague.com/api';
const RATE_LIMIT_DELAY = 100; // ms between requests

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: Verify admin token
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (!authHeader || authHeader !== expectedToken) {
    console.error('Unauthorized quick sync attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('⚡ Starting QUICK stats sync (recent players only)...');
  const startTime = Date.now();

  try {
    // Get current gameweek
    const { data: currentGW } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('is_current', true)
      .single();

    if (!currentGW) {
      throw new Error('No current gameweek found');
    }

    console.log(`  → Syncing recent players for ${currentGW.name} and previous 2 gameweeks...`);

    // Fetch fixtures to find which players played recently
    const fixturesResponse = await fetch(`${FPL_API_BASE}/fixtures/`);
    if (!fixturesResponse.ok) {
      throw new Error(`FPL API error: ${fixturesResponse.status}`);
    }
    const fixtures = await fixturesResponse.json();

    // Get finished fixtures from last 3 gameweeks (catches missing data)
    const recentGWs = [currentGW.id, currentGW.id - 1, currentGW.id - 2].filter(gw => gw > 0);
    const recentFixtures = fixtures.filter(f =>
      f.finished &&
      f.event &&
      recentGWs.includes(f.event)
    );

    console.log(`  → Found ${recentFixtures.length} recent fixtures`);

    // Extract unique player IDs who played in these fixtures
    const recentPlayerIds = new Set();
    recentFixtures.forEach(fixture => {
      if (fixture.stats) {
        fixture.stats.forEach(statEntry => {
          if (statEntry.h) statEntry.h.forEach(p => recentPlayerIds.add(p.element));
          if (statEntry.a) statEntry.a.forEach(p => recentPlayerIds.add(p.element));
        });
      }
    });

    const playerIds = Array.from(recentPlayerIds);
    console.log(`  → Syncing ${playerIds.length} players who played recently...`);

    let updatedPlayers = 0;
    let errors = 0;

    // Process players in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < playerIds.length; i += BATCH_SIZE) {
      const batch = playerIds.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (playerId) => {
        try {
          // Fetch player's element-summary
          const response = await fetch(`${FPL_API_BASE}/element-summary/${playerId}/`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const summary = await response.json();

          // Get recent gameweeks from history
          const history = summary.history || [];

          // Update stats for each recent gameweek
          for (const gwData of history) {
            if (recentGWs.includes(gwData.round)) {
              const { error } = await supabase
                .from('player_gameweek_stats')
                .upsert({
                  player_id: playerId,
                  gameweek_id: gwData.round,
                  opponent_team: gwData.opponent_team,
                  was_home: gwData.was_home,
                  kickoff_time: gwData.kickoff_time,
                  total_points: gwData.total_points,
                  minutes: gwData.minutes,
                  goals_scored: gwData.goals_scored,
                  assists: gwData.assists,
                  clean_sheets: gwData.clean_sheets,
                  goals_conceded: gwData.goals_conceded,
                  bonus: gwData.bonus,
                  bps: gwData.bps,
                  own_goals: gwData.own_goals || 0,
                  penalties_saved: gwData.penalties_saved || 0,
                  penalties_missed: gwData.penalties_missed || 0,
                  yellow_cards: gwData.yellow_cards || 0,
                  red_cards: gwData.red_cards || 0,
                  saves: gwData.saves || 0,
                  expected_goals: gwData.expected_goals || 0,
                  expected_assists: gwData.expected_assists || 0,
                  expected_goal_involvements: gwData.expected_goal_involvements || 0,
                  expected_goals_conceded: gwData.expected_goals_conceded || 0,
                  value: gwData.value,
                  selected: gwData.selected,
                  transfers_in: gwData.transfers_in || 0,
                  transfers_out: gwData.transfers_out || 0,
                  influence: gwData.influence || 0,
                  creativity: gwData.creativity || 0,
                  threat: gwData.threat || 0,
                  ict_index: gwData.ict_index || 0
                }, { onConflict: 'player_id,gameweek_id' });

              if (error) {
                console.error(`  ✗ Player ${playerId} GW${gwData.round}:`, error.message);
                errors++;
              } else {
                updatedPlayers++;
              }
            }
          }
        } catch (error) {
          console.error(`  ✗ Failed to sync player ${playerId}:`, error.message);
          errors++;
        }
      }));

      // Rate limiting between batches
      await delay(RATE_LIMIT_DELAY * BATCH_SIZE);

      // Progress log every 10 batches
      if ((i / BATCH_SIZE + 1) % 10 === 0) {
        const progress = Math.round(((i + BATCH_SIZE) / playerIds.length) * 100);
        console.log(`  ⏳ Progress: ${progress}% (${updatedPlayers} updated, ${errors} errors)`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✓ Quick sync complete in ${duration}s`);
    console.log(`  Players synced: ${playerIds.length}`);
    console.log(`  Stats updated: ${updatedPlayers}`);
    console.log(`  Errors: ${errors}`);

    return res.status(200).json({
      success: true,
      message: 'Quick sync completed successfully',
      stats: {
        gameweek: currentGW.name,
        gameweeks_synced: recentGWs,
        players_synced: playerIds.length,
        stats_updated: updatedPlayers,
        errors,
        duration_seconds: parseFloat(duration)
      }
    });

  } catch (error) {
    console.error('❌ Quick sync failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Quick sync failed',
      message: error.message
    });
  }
}

// Max timeout on Hobby plan - should complete in ~40 seconds for current GW
export const config = {
  maxDuration: 60,
};
