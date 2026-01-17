/**
 * API Endpoint: /api/players/[id]/history
 *
 * Fetches gameweek-by-gameweek history for a specific player
 * Returns detailed stats for each gameweek including opponent and fixture info
 *
 * Path Parameters:
 *   - id: Player ID
 *
 * Query Parameters:
 *   - seasonId: Optional season ID (defaults to current season)
 *   - limit: Optional limit on number of gameweeks (default: all)
 *
 * Example:
 *   GET /api/players/123/history
 *   GET /api/players/123/history?limit=10
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

  const { id } = req.query;
  const { seasonId, limit } = req.query;

  // Validate player ID
  const playerId = parseInt(id);
  if (isNaN(playerId)) {
    return res.status(400).json({
      error: 'Invalid player ID',
      message: 'Player ID must be a valid integer'
    });
  }

  try {
    // Build the query
    let query = supabase
      .from('player_gameweek_stats')
      .select(`
        *,
        gameweeks!inner(
          id,
          name,
          deadline_time,
          finished,
          is_current
        ),
        teams!opponent_team(
          id,
          short_name,
          name
        )
      `)
      .eq('player_id', playerId)
      .order('gameweek_id', { ascending: true });

    // Apply limit if specified
    if (limit) {
      const limitNum = parseInt(limit);
      if (!isNaN(limitNum) && limitNum > 0) {
        query = query.limit(limitNum);
      }
    }

    const { data, error } = await query;

    if (error) {
      console.error('Supabase query error:', error);
      throw error;
    }

    // Fetch player info
    const { data: playerData, error: playerError } = await supabase
      .from('players')
      .select(`
        id,
        web_name,
        first_name,
        second_name,
        element_type,
        teams!inner(id, short_name, name)
      `)
      .eq('id', playerId)
      .single();

    if (playerError) {
      console.error('Supabase player query error:', playerError);
      throw playerError;
    }

    // Transform data for easier frontend consumption
    const history = data.map(gw => ({
      gameweek_id: gw.gameweek_id,
      gameweek_name: gw.gameweeks.name,
      deadline_time: gw.gameweeks.deadline_time,
      finished: gw.gameweeks.finished,
      is_current: gw.gameweeks.is_current,
      opponent_team_id: gw.opponent_team,
      opponent_team_name: gw.teams?.name,
      opponent_team_short_name: gw.teams?.short_name,
      was_home: gw.was_home,
      kickoff_time: gw.kickoff_time,
      stats: {
        total_points: gw.total_points,
        minutes: gw.minutes,
        goals_scored: gw.goals_scored,
        assists: gw.assists,
        clean_sheets: gw.clean_sheets,
        goals_conceded: gw.goals_conceded,
        bonus: gw.bonus,
        bps: gw.bps,
        own_goals: gw.own_goals,
        penalties_saved: gw.penalties_saved,
        penalties_missed: gw.penalties_missed,
        yellow_cards: gw.yellow_cards,
        red_cards: gw.red_cards,
        saves: gw.saves,
        expected_goals: gw.expected_goals,
        expected_assists: gw.expected_assists,
        expected_goal_involvements: gw.expected_goal_involvements,
        expected_goals_conceded: gw.expected_goals_conceded,
        influence: gw.influence,
        creativity: gw.creativity,
        threat: gw.threat,
        ict_index: gw.ict_index
      },
      ownership: {
        value: gw.value,
        selected: gw.selected,
        transfers_in: gw.transfers_in,
        transfers_out: gw.transfers_out
      }
    }));

    // Calculate summary stats
    const summary = {
      total_gameweeks: history.length,
      total_points: history.reduce((sum, gw) => sum + gw.stats.total_points, 0),
      total_minutes: history.reduce((sum, gw) => sum + gw.stats.minutes, 0),
      total_goals: history.reduce((sum, gw) => sum + gw.stats.goals_scored, 0),
      total_assists: history.reduce((sum, gw) => sum + gw.stats.assists, 0),
      total_clean_sheets: history.reduce((sum, gw) => sum + gw.stats.clean_sheets, 0),
      total_bonus: history.reduce((sum, gw) => sum + gw.stats.bonus, 0),
      average_points: history.length > 0
        ? (history.reduce((sum, gw) => sum + gw.stats.total_points, 0) / history.length).toFixed(2)
        : 0
    };

    // Return successful response
    res.status(200).json({
      success: true,
      player: {
        id: playerData.id,
        web_name: playerData.web_name,
        first_name: playerData.first_name,
        second_name: playerData.second_name,
        element_type: playerData.element_type,
        team_id: playerData.teams.id,
        team_name: playerData.teams.name,
        team_short_name: playerData.teams.short_name
      },
      summary,
      history
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
