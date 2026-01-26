/**
 * API Endpoint: /api/sync/full-stats
 *
 * FULL SYNC: Syncs ALL players for complete historical data
 * This takes 60-120 seconds for 700+ players
 *
 * Run this WEEKLY (or manually when needed)
 *
 * For quick hourly updates, use /api/sync/quick-stats instead
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
const RATE_LIMIT_DELAY = 50; // Faster for full sync (still safe)

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: Verify admin token
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (!authHeader || authHeader !== expectedToken) {
    console.error('Unauthorized full sync attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('🔄 Starting FULL stats sync (all players, all gameweeks)...');
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

    console.log(`  → Full sync up to ${currentGW.name}...`);

    // Fetch all players from bootstrap-static
    const bootstrapResponse = await fetch(`${FPL_API_BASE}/bootstrap-static/`);
    if (!bootstrapResponse.ok) {
      throw new Error(`FPL API error: ${bootstrapResponse.status}`);
    }
    const bootstrap = await bootstrapResponse.json();

    const players = bootstrap.elements;
    console.log(`  → Syncing ${players.length} players...`);

    let updatedPlayers = 0;
    let errors = 0;

    // Process players in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (player) => {
        try {
          // Fetch player's element-summary
          const response = await fetch(`${FPL_API_BASE}/element-summary/${player.id}/`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const summary = await response.json();

          // Get all gameweek history up to current GW
          const history = summary.history || [];
          const relevantHistory = history.filter(gw => gw.round <= currentGW.id);

          // Update stats for each gameweek
          for (const gwData of relevantHistory) {
            const { error } = await supabase
              .from('player_gameweek_stats')
              .upsert({
                player_id: player.id,
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
              errors++;
            } else {
              updatedPlayers++;
            }
          }
        } catch (error) {
          console.error(`  ✗ Failed to sync ${player.web_name}:`, error.message);
          errors++;
        }
      }));

      // Rate limiting between batches
      await delay(RATE_LIMIT_DELAY * BATCH_SIZE);

      // Progress log every 10 batches
      if ((i / BATCH_SIZE + 1) % 10 === 0) {
        const progress = Math.round(((i + BATCH_SIZE) / players.length) * 100);
        console.log(`  ⏳ Progress: ${progress}% (${updatedPlayers} updated, ${errors} errors)`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✓ Full sync complete in ${duration}s`);
    console.log(`  Players synced: ${players.length}`);
    console.log(`  Stats updated: ${updatedPlayers}`);
    console.log(`  Errors: ${errors}`);

    return res.status(200).json({
      success: true,
      message: 'Full sync completed successfully',
      stats: {
        gameweek: currentGW.name,
        players_synced: players.length,
        stats_updated: updatedPlayers,
        errors,
        duration_seconds: parseFloat(duration)
      }
    });

  } catch (error) {
    console.error('❌ Full sync failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Full sync failed',
      message: error.message
    });
  }
}

// Longer timeout for full sync - may take 60-120 seconds
export const config = {
  maxDuration: 300, // 5 minutes max (requires Vercel Pro, but we'll use fire-and-forget)
};
