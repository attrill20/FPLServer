/**
 * API Endpoint: /api/sync/players
 *
 * Syncs players table from FPL API bootstrap-static
 * Adds new players (mid-season transfers) and updates existing player info
 *
 * This should run BEFORE player_gameweek_stats sync to avoid foreign key errors
 *
 * Fast: Completes in ~2 seconds
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: Verify admin token
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (!authHeader || authHeader !== expectedToken) {
    console.error('Unauthorized players sync attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('👥 Starting players sync...');
  const startTime = Date.now();

  try {
    // Fetch bootstrap-static data (contains all players)
    const response = await fetch(`${FPL_API_BASE}/bootstrap-static/`);
    if (!response.ok) {
      throw new Error(`FPL API error: ${response.status}`);
    }
    const bootstrap = await response.json();

    const players = bootstrap.elements;
    console.log(`  → Syncing ${players.length} players...`);

    // Build the full batch — single upsert call instead of 809 individual ones
    const playerRecords = players.map(player => ({
      id: player.id,
      code: player.code,
      team_id: player.team,
      web_name: player.web_name,
      first_name: player.first_name,
      second_name: player.second_name,
      element_type: player.element_type
    }));

    const { error } = await supabase
      .from('players')
      .upsert(playerRecords, { onConflict: 'id' });

    if (error) {
      throw new Error(`Batch upsert failed: ${error.message}`);
    }

    // Sync gameweek statuses from FPL API bootstrap events
    const apiCurrentGW = bootstrap.events.find(e => e.is_current);
    let gameweekAdvanced = null;

    if (apiCurrentGW) {
      const { data: dbCurrentGW } = await supabase
        .from('gameweeks')
        .select('id, name')
        .eq('is_current', true)
        .single();

      if (dbCurrentGW && dbCurrentGW.id !== apiCurrentGW.id) {
        console.log(`  → Advancing gameweek: ${dbCurrentGW.name} → Gameweek ${apiCurrentGW.id}`);

        await supabase
          .from('gameweeks')
          .update({ is_current: false, finished: true })
          .eq('id', dbCurrentGW.id);

        await supabase
          .from('gameweeks')
          .update({ is_current: true, finished: apiCurrentGW.finished })
          .eq('id', apiCurrentGW.id);

        gameweekAdvanced = { from: dbCurrentGW.id, to: apiCurrentGW.id };
      } else {
        // Same gameweek — just keep finished flag in sync
        await supabase
          .from('gameweeks')
          .update({ finished: apiCurrentGW.finished })
          .eq('id', apiCurrentGW.id);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✓ Players sync complete in ${duration}s (${players.length} players)`);

    return res.status(200).json({
      success: true,
      message: 'Players synced successfully',
      stats: {
        total_players: players.length,
        duration_seconds: parseFloat(duration),
        gameweek_advanced: gameweekAdvanced
      }
    });

  } catch (error) {
    console.error('❌ Players sync failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Players sync failed',
      message: error.message
    });
  }
}

export const config = {
  maxDuration: 60,
};
