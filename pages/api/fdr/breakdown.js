/**
 * GET /api/fdr/breakdown?team_id=1
 *
 * Returns detailed factor breakdown for a specific team
 * Public endpoint used for debugging and comparison dashboard
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  const { team_id } = req.query;

  if (!team_id) {
    return res.status(400).json({
      success: false,
      error: 'team_id parameter required'
    });
  }

  const teamIdNum = parseInt(team_id);
  if (isNaN(teamIdNum)) {
    return res.status(400).json({
      success: false,
      error: 'team_id must be a valid integer'
    });
  }

  try {
    // Get latest calculation for this team
    const { data: calculation, error: calcError } = await supabase
      .from('team_fdr_calculations')
      .select('*')
      .eq('team_id', teamIdNum)
      .order('calculation_timestamp', { ascending: false })
      .limit(1)
      .single();

    if (calcError) {
      if (calcError.code === 'PGRST116') {
        // No rows found
        return res.status(404).json({
          success: false,
          error: 'No FDR calculation found for this team',
          message: 'FDR may not have been calculated yet. Try running /api/fdr/calculate first.'
        });
      }
      throw new Error(`Failed to fetch breakdown: ${calcError.message}`);
    }

    // Get team info
    const { data: team, error: teamError } = await supabase
      .from('teams')
      .select('name, short_name, home_difficulty, away_difficulty')
      .eq('id', teamIdNum)
      .single();

    if (teamError) {
      throw new Error(`Failed to fetch team: ${teamError.message}`);
    }

    // Get active weighting profile
    const { data: weights, error: weightError } = await supabase
      .from('fdr_weightings')
      .select('*')
      .eq('is_active', true)
      .single();

    if (weightError) {
      console.warn('No active weighting profile found');
    }

    // Get gameweek info
    const { data: gameweek, error: gwError } = await supabase
      .from('gameweeks')
      .select('name')
      .eq('id', calculation.gameweek_calculated)
      .single();

    return res.status(200).json({
      success: true,
      team: {
        id: teamIdNum,
        name: team.name,
        short_name: team.short_name
      },
      calculation: {
        timestamp: calculation.calculation_timestamp,
        gameweek: gameweek?.name || `GW ${calculation.gameweek_calculated}`,
        games_played: calculation.games_played
      },
      factors: {
        goals_per_90: parseFloat(calculation.goals_per_90_score || 0),
        goals_conceded_per_90: parseFloat(calculation.goals_conceded_per_90_score || 0),
        xg_per_90: parseFloat(calculation.xg_per_90_score || 0),
        xgc_per_90: parseFloat(calculation.xgc_per_90_score || 0),
        home_goals_per_90: parseFloat(calculation.home_goals_per_90_score || 0),
        home_xg_per_90: parseFloat(calculation.home_xg_per_90_score || 0),
        away_goals_per_90: parseFloat(calculation.away_goals_per_90_score || 0),
        away_xg_per_90: parseFloat(calculation.away_xg_per_90_score || 0),
        recent_form: parseFloat(calculation.recent_form_score || 0),
        ppg: parseFloat(calculation.ppg_score || 0),
        goals_vs_xg: parseFloat(calculation.goals_vs_xg_score || 0)
      },
      raw_values: {
        description: 'Non-normalized values for reference',
        note: 'These are the actual stats before normalization to 0-100 scale'
      },
      scores: {
        home_strength: parseFloat(calculation.home_strength_score || 0),
        away_strength: parseFloat(calculation.away_strength_score || 0),
        overall_strength: parseFloat(calculation.overall_strength_score || 0)
      },
      ratings: {
        home_difficulty: team.home_difficulty || calculation.home_difficulty || 5,
        away_difficulty: team.away_difficulty || calculation.away_difficulty || 5
      },
      weights: weights ? {
        profile_name: weights.name,
        description: weights.description,
        factors: {
          goals_per_90: parseFloat(weights.weight_goals_per_90),
          goals_conceded_per_90: parseFloat(weights.weight_goals_conceded_per_90),
          xg_per_90: parseFloat(weights.weight_xg_per_90),
          xgc_per_90: parseFloat(weights.weight_xgc_per_90),
          home_goals_per_90: parseFloat(weights.weight_home_goals_per_90),
          home_xg_per_90: parseFloat(weights.weight_home_xg_per_90),
          away_goals_per_90: parseFloat(weights.weight_away_goals_per_90),
          away_xg_per_90: parseFloat(weights.weight_away_xg_per_90),
          recent_form: parseFloat(weights.weight_recent_form),
          ppg: parseFloat(weights.weight_ppg),
          goals_vs_xg: parseFloat(weights.weight_goals_vs_xg)
        },
        recent_form_params: {
          gameweeks: weights.recent_form_gameweeks,
          weight_percentage: parseFloat(weights.recent_form_weight_pct)
        }
      } : null
    });

  } catch (error) {
    console.error('Failed to fetch FDR breakdown:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch breakdown',
      message: error.message
    });
  }
}
