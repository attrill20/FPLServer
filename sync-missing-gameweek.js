#!/usr/bin/env node

/**
 * Local script to sync a specific gameweek
 * Run this on your local machine - NO timeout limits!
 *
 * Usage:
 *   node scripts/sync-missing-gameweek.js 22
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const FPL_API_BASE = 'https://fantasy.premierleague.com/api';
const RATE_LIMIT_DELAY = 50;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function syncGameweek(targetGW) {
  console.log(`🔄 Starting sync for Gameweek ${targetGW}...`);
  const startTime = Date.now();

  try {
    // Fetch all players
    console.log('  → Fetching player list from FPL API...');
    const bootstrapResponse = await fetch(`${FPL_API_BASE}/bootstrap-static/`);
    if (!bootstrapResponse.ok) {
      throw new Error(`FPL API error: ${bootstrapResponse.status}`);
    }
    const bootstrap = await bootstrapResponse.json();
    const players = bootstrap.elements;

    console.log(`  → Found ${players.length} players, syncing GW${targetGW} data...`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // Process in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
      const batch = players.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (player) => {
        try {
          const response = await fetch(`${FPL_API_BASE}/element-summary/${player.id}/`);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const summary = await response.json();

          const history = summary.history || [];
          const gwData = history.find(gw => gw.round === targetGW);

          if (gwData) {
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
              console.error(`  ✗ ${player.web_name}:`, error.message);
              errors++;
            } else {
              updated++;
            }
          } else {
            skipped++;
          }
        } catch (error) {
          console.error(`  ✗ Failed ${player.web_name}:`, error.message);
          errors++;
        }
      }));

      await delay(RATE_LIMIT_DELAY * BATCH_SIZE);

      if ((i / BATCH_SIZE + 1) % 10 === 0) {
        const progress = Math.round(((i + BATCH_SIZE) / players.length) * 100);
        console.log(`  ⏳ ${progress}% (${updated} synced, ${skipped} skipped, ${errors} errors)`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n✅ Sync complete in ${duration}s`);
    console.log(`   Players synced: ${updated}`);
    console.log(`   Players skipped: ${skipped}`);
    console.log(`   Errors: ${errors}`);

  } catch (error) {
    console.error('❌ Sync failed:', error);
    process.exit(1);
  }
}

// Get gameweek from command line
const targetGW = parseInt(process.argv[2]);

if (!targetGW || isNaN(targetGW) || targetGW < 1 || targetGW > 38) {
  console.error('Usage: node sync-missing-gameweek.js <gameweek>');
  console.error('Example: node sync-missing-gameweek.js 22');
  process.exit(1);
}

syncGameweek(targetGW);
