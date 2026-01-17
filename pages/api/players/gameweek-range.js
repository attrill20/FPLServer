/**
 * API Endpoint: /api/players/gameweek-range
 *
 * Fetches aggregated player stats for a specific gameweek range
 * Used by the frontend GW filter to show filtered stats
 *
 * Query Parameters:
 *   - playerIds: Comma-separated player IDs (e.g., "1,2,3")
 *   - startGW: Starting gameweek (e.g., "1")
 *   - endGW: Ending gameweek (e.g., "10")
 *   - seasonId: Optional season ID (defaults to current season)
 *
 * Example:
 *   GET /api/players/gameweek-range?playerIds=1,2,3&startGW=1&endGW=10
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle OPTIONS request for CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { playerIds, startGW, endGW, seasonId } = req.query;

  // Validate required parameters
  if (!playerIds || !startGW || !endGW) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['playerIds', 'startGW', 'endGW'],
      received: { playerIds, startGW, endGW }
    });
  }

  try {
    // Parse playerIds from comma-separated string to array
    const playerIdArray = playerIds.split(',').map(id => {
      const parsed = parseInt(id.trim());
      if (isNaN(parsed)) {
        throw new Error(`Invalid player ID: ${id}`);
      }
      return parsed;
    });

    // Parse and validate gameweek range
    const startGameweek = parseInt(startGW);
    const endGameweek = parseInt(endGW);

    if (isNaN(startGameweek) || isNaN(endGameweek)) {
      return res.status(400).json({
        error: 'Invalid gameweek range',
        message: 'startGW and endGW must be valid integers'
      });
    }

    if (startGameweek > endGameweek) {
      return res.status(400).json({
        error: 'Invalid gameweek range',
        message: 'startGW must be less than or equal to endGW'
      });
    }

    if (startGameweek < 1 || endGameweek > 38) {
      return res.status(400).json({
        error: 'Invalid gameweek range',
        message: 'Gameweeks must be between 1 and 38'
      });
    }

    // Call the aggregation function
    const { data: statsData, error: statsError } = await supabase
      .rpc('aggregate_player_stats_by_gw_range', {
        player_ids: playerIdArray,
        start_gw: startGameweek,
        end_gw: endGameweek
      });

    if (statsError) {
      console.error('Supabase RPC error:', statsError);
      throw statsError;
    }

    // Fetch player metadata to enrich the response
    const { data: playersData, error: playersError } = await supabase
      .from('players')
      .select(`
        id,
        web_name,
        first_name,
        second_name,
        element_type,
        teams!inner(id, short_name, name)
      `)
      .in('id', playerIdArray);

    if (playersError) {
      console.error('Supabase players query error:', playersError);
      throw playersError;
    }

    // Merge stats with player info
    const enrichedData = statsData.map(stat => {
      const player = playersData.find(p => p.id === stat.player_id);
      return {
        ...stat,
        web_name: player?.web_name,
        first_name: player?.first_name,
        second_name: player?.second_name,
        element_type: player?.element_type,
        team_id: player?.teams?.id,
        team_name: player?.teams?.name,
        team_short_name: player?.teams?.short_name
      };
    });

    // Return successful response
    res.status(200).json({
      success: true,
      data: enrichedData,
      meta: {
        player_count: enrichedData.length,
        gameweek_range: {
          start: startGameweek,
          end: endGameweek,
          total_gameweeks: endGameweek - startGameweek + 1
        }
      }
    });

  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
