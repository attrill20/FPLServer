/**
 * API Endpoint: /api/sync/live-gameweek
 *
 * Syncs the current live gameweek data from FPL API to Supabase
 * Called by Vercel cron job every 5 minutes during gameweeks
 *
 * Security: Protected by CRON_SECRET header
 *
 * Example:
 *   POST /api/sync/live-gameweek
 *   Headers: x-vercel-cron-secret: <CRON_SECRET>
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // Use service key for write access
);

const FPL_API_BASE = 'https://fantasy.premierleague.com/api';
const RATE_LIMIT_DELAY = 100; // milliseconds between requests

// Helper: Delay function for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default async function handler(req, res) {
  // Security: Verify cron secret
  const cronSecret = req.headers['x-vercel-cron-secret'];

  if (cronSecret !== process.env.CRON_SECRET) {
    console.error('Unauthorized sync attempt - invalid cron secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('🔄 Starting live gameweek sync...');
  const startTime = Date.now();

  try {
    // Step 1: Get current gameweek from Supabase
    const { data: currentGW, error: gwError } = await supabase
      .from('gameweeks')
      .select('id, name, finished')
      .eq('is_current', true)
      .single();

    if (gwError) {
      throw new Error(`Failed to get current gameweek: ${gwError.message}`);
    }

    if (!currentGW) {
      console.log('ℹ️  No active gameweek found');
      return res.status(200).json({
        success: true,
        message: 'No active gameweek to sync'
      });
    }

    // Don't sync if gameweek is already finished
    if (currentGW.finished) {
      console.log(`ℹ️  ${currentGW.name} is already finished`);
      return res.status(200).json({
        success: true,
        message: `${currentGW.name} is finished - no sync needed`
      });
    }

    console.log(`📊 Syncing ${currentGW.name} (ID: ${currentGW.id})...`);

    // Step 2: Fetch latest bootstrap-static data
    const bootstrapResponse = await fetch(`${FPL_API_BASE}/bootstrap-static/`);
    if (!bootstrapResponse.ok) {
      throw new Error(`FPL API error: ${bootstrapResponse.status}`);
    }
    const bootstrap = await bootstrapResponse.json();

    // Step 3: Update gameweek status
    const currentEvent = bootstrap.events.find(e => e.id === currentGW.id);
    if (currentEvent) {
      await supabase
        .from('gameweeks')
        .update({
          finished: currentEvent.finished,
          is_current: currentEvent.is_current
        })
        .eq('id', currentGW.id);
    }

    // Step 4: Sync player stats for current gameweek
    let updatedPlayers = 0;
    let errors = 0;
    const players = bootstrap.elements;

    console.log(`👥 Processing ${players.length} players...`);

    // Process players in batches for better performance
    const BATCH_SIZE = 10;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);

      // Process batch in parallel (but still respect overall rate limit)
      await Promise.all(batch.map(async (player) => {
        try {
          // Fetch player's element-summary
          const summaryResponse = await fetch(`${FPL_API_BASE}/element-summary/${player.id}/`);
          if (!summaryResponse.ok) {
            throw new Error(`HTTP ${summaryResponse.status}`);
          }
          const summary = await summaryResponse.json();

          // Get the latest gameweek from history
          const history = summary.history || [];
          const latestGW = history[history.length - 1];

          // Only update if the latest GW matches current GW
          if (latestGW && latestGW.round === currentGW.id) {
            const { error } = await supabase
              .from('player_gameweek_stats')
              .upsert({
                player_id: player.id,
                gameweek_id: latestGW.round,
                opponent_team: latestGW.opponent_team,
                was_home: latestGW.was_home,
                kickoff_time: latestGW.kickoff_time,
                total_points: latestGW.total_points,
                minutes: latestGW.minutes,
                goals_scored: latestGW.goals_scored,
                assists: latestGW.assists,
                clean_sheets: latestGW.clean_sheets,
                goals_conceded: latestGW.goals_conceded,
                bonus: latestGW.bonus,
                bps: latestGW.bps,
                own_goals: latestGW.own_goals || 0,
                penalties_saved: latestGW.penalties_saved || 0,
                penalties_missed: latestGW.penalties_missed || 0,
                yellow_cards: latestGW.yellow_cards || 0,
                red_cards: latestGW.red_cards || 0,
                saves: latestGW.saves || 0,
                expected_goals: latestGW.expected_goals || 0,
                expected_assists: latestGW.expected_assists || 0,
                expected_goal_involvements: latestGW.expected_goal_involvements || 0,
                expected_goals_conceded: latestGW.expected_goals_conceded || 0,
                value: latestGW.value,
                selected: latestGW.selected,
                transfers_in: latestGW.transfers_in || 0,
                transfers_out: latestGW.transfers_out || 0,
                influence: latestGW.influence || 0,
                creativity: latestGW.creativity || 0,
                threat: latestGW.threat || 0,
                ict_index: latestGW.ict_index || 0
              }, { onConflict: 'player_id,gameweek_id' });

            if (error) {
              console.error(`  ✗ ${player.web_name}:`, error.message);
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

    console.log(`✓ Sync complete in ${duration}s`);
    console.log(`  Updated: ${updatedPlayers} players`);
    console.log(`  Errors: ${errors}`);

    return res.status(200).json({
      success: true,
      message: `${currentGW.name} synced successfully`,
      stats: {
        gameweek: currentGW.name,
        gameweek_id: currentGW.id,
        players_updated: updatedPlayers,
        errors,
        duration_seconds: parseFloat(duration)
      }
    });

  } catch (error) {
    console.error('❌ Sync failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Sync failed',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// Configure API route for longer timeout (Vercel default is 10s, max is 60s for hobby)
export const config = {
  maxDuration: 60, // seconds
};
