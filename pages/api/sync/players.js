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
import { getCurrentSeason, syncTeams, getGameweekIdByRound } from '../../../lib/fplSync.js';

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
    // Fetch bootstrap-static data (contains all players) with browser-like headers
    const response = await fetch(`${FPL_API_BASE}/bootstrap-static/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://fantasy.premierleague.com/',
        'Origin': 'https://fantasy.premierleague.com'
      }
    });
    if (!response.ok) {
      throw new Error(`FPL API error: ${response.status}`);
    }
    const bootstrap = await response.json();

    const players = bootstrap.elements;
    console.log(`  → Syncing ${players.length} players...`);

    const currentSeason = await getCurrentSeason(supabase);

    // FPL resets team ids every season on promotion/relegation — translate via
    // the stable `code` field rather than trusting the raw team id.
    const apiTeamIdToOurTeamId = await syncTeams(supabase, bootstrap);

    // FPL also resets player element ids every season — match existing players
    // by their stable `code` and keep their existing DB id; only brand-new
    // players (transfers into the league) get a freshly assigned id.
    const { data: dbPlayers, error: playersLoadError } = await supabase
      .from('players')
      .select('id, code');
    if (playersLoadError) {
      throw new Error(`Failed to load existing players: ${playersLoadError.message}`);
    }
    const dbPlayerByCode = new Map(dbPlayers.map(p => [p.code, p.id]));
    let nextPlayerId = Math.max(...dbPlayers.map(p => p.id)) + 1;

    const playerRecords = players.map(player => ({
      id: dbPlayerByCode.get(player.code) ?? nextPlayerId++,
      code: player.code,
      team_id: apiTeamIdToOurTeamId.get(player.team),
      web_name: player.web_name,
      first_name: player.first_name,
      second_name: player.second_name,
      element_type: player.element_type,
      season_id: currentSeason.id
    }));

    const { error } = await supabase
      .from('players')
      .upsert(playerRecords, { onConflict: 'id' });

    if (error) {
      throw new Error(`Batch upsert failed: ${error.message}`);
    }

    // Sync gameweek statuses from FPL API bootstrap events
    const gwIdByRound = await getGameweekIdByRound(supabase, currentSeason.id);
    const apiCurrentGW = bootstrap.events.find(e => e.is_current);
    let gameweekAdvanced = null;

    if (apiCurrentGW) {
      const targetGwId = gwIdByRound.get(apiCurrentGW.id);

      if (!targetGwId) {
        console.warn(`  ⚠ No DB gameweek found for round ${apiCurrentGW.id} in season ${currentSeason.id}`);
      } else {
        // maybeSingle (not single) — zero rows is a valid state (e.g. right
        // after a season rollover) and must not be treated as "no change needed"
        const { data: dbCurrentGW } = await supabase
          .from('gameweeks')
          .select('id, name')
          .eq('is_current', true)
          .maybeSingle();

        if (!dbCurrentGW || dbCurrentGW.id !== targetGwId) {
          console.log(`  → Advancing gameweek: ${dbCurrentGW?.name ?? '(none)'} → ${apiCurrentGW.name}`);

          if (dbCurrentGW) {
            await supabase
              .from('gameweeks')
              .update({ is_current: false, finished: true })
              .eq('id', dbCurrentGW.id);
          }

          await supabase
            .from('gameweeks')
            .update({ is_current: true, finished: apiCurrentGW.finished })
            .eq('id', targetGwId);

          gameweekAdvanced = { from: dbCurrentGW?.id ?? null, to: targetGwId };
        } else {
          // Same gameweek — just keep finished flag in sync
          await supabase
            .from('gameweeks')
            .update({ finished: apiCurrentGW.finished })
            .eq('id', targetGwId);
        }
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
