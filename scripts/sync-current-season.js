/**
 * Sync Current Season Data to Supabase
 *
 * This script fetches data from the FPL API and populates the Supabase database
 * with current season data including:
 * - Teams
 * - Gameweeks
 * - Players
 * - Player gameweek stats
 *
 * Usage:
 *   node scripts/sync-current-season.js
 *
 * Environment variables required:
 *   SUPABASE_URL - Your Supabase project URL
 *   SUPABASE_SERVICE_KEY - Your Supabase service role key (not anon key!)
 */

import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FPL_API_BASE = 'https://fantasy.premierleague.com/api';
const RATE_LIMIT_DELAY = 100; // milliseconds between requests (10/sec = 100ms)

// Initialize Supabase client with service role key
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  console.error('Example: SUPABASE_URL=https://xxx.supabase.co SUPABASE_SERVICE_KEY=xxx node scripts/sync-current-season.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Helper: Delay function for rate limiting
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Fetch with retry logic
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      console.warn(`Fetch attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === retries - 1) throw error;
      await delay(1000 * (i + 1)); // Exponential backoff
    }
  }
}

/**
 * Step 1: Get current season ID
 */
async function getCurrentSeason() {
  console.log('\n📅 Getting current season...');
  const { data, error } = await supabase
    .from('seasons')
    .select('id, name')
    .eq('is_current', true)
    .single();

  if (error) {
    throw new Error(`Failed to get current season: ${error.message}`);
  }

  console.log(`✓ Current season: ${data.name} (ID: ${data.id})`);
  return data;
}

/**
 * Step 2: Sync teams
 */
async function syncTeams(bootstrapData) {
  console.log('\n⚽ Syncing teams...');
  const teams = bootstrapData.teams;

  for (const team of teams) {
    const { error } = await supabase
      .from('teams')
      .upsert({
        id: team.id,
        code: team.code,
        name: team.name,
        short_name: team.short_name,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

    if (error) {
      console.error(`  ✗ Failed to upsert team ${team.name}:`, error.message);
    } else {
      console.log(`  ✓ ${team.name}`);
    }
  }

  console.log(`✓ Synced ${teams.length} teams`);
}

/**
 * Step 3: Sync gameweeks
 */
async function syncGameweeks(bootstrapData, seasonId) {
  console.log('\n📆 Syncing gameweeks...');
  const events = bootstrapData.events;

  for (const event of events) {
    const { error } = await supabase
      .from('gameweeks')
      .upsert({
        id: event.id,
        season_id: seasonId,
        name: event.name,
        deadline_time: event.deadline_time,
        finished: event.finished,
        is_current: event.is_current
      }, { onConflict: 'id' });

    if (error) {
      console.error(`  ✗ Failed to upsert ${event.name}:`, error.message);
    } else {
      const status = event.is_current ? '(CURRENT)' : event.finished ? '(finished)' : '(upcoming)';
      console.log(`  ✓ ${event.name} ${status}`);
    }
  }

  console.log(`✓ Synced ${events.length} gameweeks`);

  // Return current gameweek for later use
  const currentGW = events.find(e => e.is_current);
  return currentGW;
}

/**
 * Step 4: Sync players
 */
async function syncPlayers(bootstrapData, seasonId) {
  console.log('\n👥 Syncing players...');
  const players = bootstrapData.elements;

  // Batch insert for better performance
  const batchSize = 50;
  for (let i = 0; i < players.length; i += batchSize) {
    const batch = players.slice(i, i + batchSize);
    const playerData = batch.map(player => ({
      id: player.id,
      code: player.code,
      first_name: player.first_name,
      second_name: player.second_name,
      web_name: player.web_name,
      season_id: seasonId,
      team_id: player.team,
      element_type: player.element_type
    }));

    const { error } = await supabase
      .from('players')
      .upsert(playerData, { onConflict: 'id' });

    if (error) {
      console.error(`  ✗ Failed to upsert batch ${i / batchSize + 1}:`, error.message);
    } else {
      console.log(`  ✓ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(players.length / batchSize)} (${batch.length} players)`);
    }
  }

  console.log(`✓ Synced ${players.length} players`);
  return players;
}

/**
 * Step 5: Sync player gameweek stats (CRITICAL)
 */
async function syncPlayerGameweekStats(players, currentGW) {
  console.log('\n📊 Syncing player gameweek stats...');
  console.log(`⏱️  This will take a while due to rate limiting (~${Math.ceil(players.length * RATE_LIMIT_DELAY / 1000)}s)`);

  let syncedPlayers = 0;
  let syncedStats = 0;
  let errors = 0;

  for (let i = 0; i < players.length; i++) {
    const player = players[i];

    try {
      // Fetch player's element-summary (contains history array)
      const summary = await fetchWithRetry(`${FPL_API_BASE}/element-summary/${player.id}/`);

      // Extract history (gameweek-by-gameweek stats)
      const history = summary.history || [];

      if (history.length > 0) {
        // Prepare batch of gameweek stats for this player
        const statsData = history.map(gw => ({
          player_id: player.id,
          gameweek_id: gw.round,
          opponent_team: gw.opponent_team,
          was_home: gw.was_home,
          kickoff_time: gw.kickoff_time,
          total_points: gw.total_points,
          minutes: gw.minutes,
          goals_scored: gw.goals_scored,
          assists: gw.assists,
          clean_sheets: gw.clean_sheets,
          goals_conceded: gw.goals_conceded,
          bonus: gw.bonus,
          bps: gw.bps,
          own_goals: gw.own_goals || 0,
          penalties_saved: gw.penalties_saved || 0,
          penalties_missed: gw.penalties_missed || 0,
          yellow_cards: gw.yellow_cards || 0,
          red_cards: gw.red_cards || 0,
          saves: gw.saves || 0,
          expected_goals: gw.expected_goals || 0,
          expected_assists: gw.expected_assists || 0,
          expected_goal_involvements: gw.expected_goal_involvements || 0,
          expected_goals_conceded: gw.expected_goals_conceded || 0,
          value: gw.value,
          selected: gw.selected,
          transfers_in: gw.transfers_in || 0,
          transfers_out: gw.transfers_out || 0,
          influence: gw.influence || 0,
          creativity: gw.creativity || 0,
          threat: gw.threat || 0,
          ict_index: gw.ict_index || 0
        }));

        // Upsert all gameweek stats for this player
        const { error } = await supabase
          .from('player_gameweek_stats')
          .upsert(statsData, { onConflict: 'player_id,gameweek_id' });

        if (error) {
          console.error(`  ✗ ${player.web_name}:`, error.message);
          errors++;
        } else {
          syncedStats += statsData.length;
        }
      }

      syncedPlayers++;

      // Progress indicator every 50 players
      if ((i + 1) % 50 === 0 || i === players.length - 1) {
        const progress = Math.round(((i + 1) / players.length) * 100);
        console.log(`  ⏳ Progress: ${i + 1}/${players.length} players (${progress}%) - ${syncedStats} stats synced`);
      }

      // Rate limiting - respect FPL API limits
      await delay(RATE_LIMIT_DELAY);

    } catch (error) {
      console.error(`  ✗ Failed to fetch stats for ${player.web_name}:`, error.message);
      errors++;
    }
  }

  console.log(`✓ Synced stats for ${syncedPlayers} players (${syncedStats} total gameweek records)`);
  if (errors > 0) {
    console.log(`⚠️  ${errors} errors occurred during sync`);
  }
}

/**
 * Main sync function
 */
async function syncCurrentSeason() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  FPL → Supabase Sync Script           ║');
  console.log('║  Current Season Data Population        ║');
  console.log('╚════════════════════════════════════════╝');

  try {
    // Step 1: Get current season
    const currentSeason = await getCurrentSeason();

    // Step 2: Fetch bootstrap-static from FPL API
    console.log('\n🌐 Fetching data from FPL API...');
    const bootstrapData = await fetchWithRetry(`${FPL_API_BASE}/bootstrap-static/`);
    console.log('✓ Bootstrap data fetched');

    // Step 3: Sync teams
    await syncTeams(bootstrapData);

    // Step 4: Sync gameweeks
    const currentGW = await syncGameweeks(bootstrapData, currentSeason.id);

    // Step 5: Sync players
    const players = await syncPlayers(bootstrapData, currentSeason.id);

    // Step 6: Sync player gameweek stats (this takes the longest)
    await syncPlayerGameweekStats(players, currentGW);

    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  ✓ SYNC COMPLETE!                      ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('\nNext steps:');
    console.log('1. Verify data in Supabase dashboard');
    console.log('2. Test aggregation function');
    console.log('3. Deploy API endpoints');
    console.log('4. Integrate frontend components');

  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the sync
syncCurrentSeason();
