/**
 * POST /api/fdr/calculate
 *
 * Calculates FDR for all teams and updates database
 * Protected endpoint - requires ADMIN_TOKEN or CRON_SECRET
 *
 * Triggered by:
 * - Vercel cron job (daily at 2 AM UTC)
 * - Manual admin request
 */

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-vercel-cron-secret');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Security check
  const authHeader = req.headers.authorization;
  const cronSecret = req.headers['x-vercel-cron-secret'];

  const isAuthorized =
    authHeader === `Bearer ${process.env.ADMIN_TOKEN}` ||
    cronSecret === process.env.CRON_SECRET;

  if (!isAuthorized) {
    console.error('❌ Unauthorized FDR calculation attempt');
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  console.log('🎯 Starting automated FDR calculation...');
  const startTime = Date.now();

  try {
    // Step 1: Calculate FDR using SQL function
    console.log('  → Running calculate_team_fdr() function...');
    const { data: fdrResults, error: calcError } = await supabase
      .rpc('calculate_team_fdr');

    if (calcError) {
      throw new Error(`FDR calculation failed: ${calcError.message}`);
    }

    if (!fdrResults || fdrResults.length === 0) {
      throw new Error('FDR calculation returned no results');
    }

    console.log(`  ✓ Calculated FDR for ${fdrResults.length} teams`);

    // Step 2: Get current gameweek and season
    const { data: currentGW, error: gwError } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('is_current', true)
      .single();

    if (gwError) {
      console.warn('Warning: Could not get current gameweek:', gwError.message);
      // Continue anyway - we can still update team ratings
    }

    const { data: currentSeason, error: seasonError } = await supabase
      .from('seasons')
      .select('id')
      .eq('is_current', true)
      .single();

    if (seasonError) {
      console.warn('Warning: Could not get current season:', seasonError.message);
    }

    // Step 3: Store calculations in team_fdr_calculations table
    if (currentGW && currentSeason) {
      console.log('  → Storing calculation records...');
      const calculationRecords = fdrResults.map(team => ({
        team_id: team.team_id,
        season_id: currentSeason.id,
        gameweek_calculated: currentGW.id,
        games_played: team.games_played || 0,
        goals_per_90_score: team.goals_per_90_score || 0,
        goals_conceded_per_90_score: team.goals_conceded_per_90_score || 0,
        xg_per_90_score: team.xg_per_90_score || 0,
        xgc_per_90_score: team.xgc_per_90_score || 0,
        recent_form_score: team.recent_form_score || 0,
        home_strength_score: team.home_strength_score || 0,
        away_strength_score: team.away_strength_score || 0,
        home_difficulty: team.home_difficulty || 5,
        away_difficulty: team.away_difficulty || 5,
        calculation_timestamp: new Date().toISOString()
      }));

      const { error: insertError } = await supabase
        .from('team_fdr_calculations')
        .upsert(calculationRecords, {
          onConflict: 'team_id,gameweek_calculated'
        });

      if (insertError) {
        console.error('  ⚠ Failed to store calculations:', insertError.message);
        // Don't fail the whole operation - ratings can still be updated
      } else {
        console.log(`  ✓ Stored ${calculationRecords.length} calculation records`);
      }
    }

    // Step 4: Update teams table with latest ratings
    console.log('  → Updating teams table...');
    const updatePromises = fdrResults.map(team =>
      supabase
        .from('teams')
        .update({
          home_difficulty: team.home_difficulty,
          away_difficulty: team.away_difficulty,
          updated_at: new Date().toISOString()
        })
        .eq('id', team.team_id)
    );

    await Promise.all(updatePromises);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`✅ FDR update complete in ${duration}s`);
    console.log(`   Gameweek: ${currentGW?.name || 'Unknown'}`);
    console.log(`   Teams updated: ${fdrResults.length}`);

    // Log some example ratings for verification
    const topTeams = fdrResults.slice(0, 3);
    console.log('   Sample ratings (top 3 by home strength):');
    topTeams.forEach(team => {
      console.log(`   - ${team.team_name}: Home=${team.home_difficulty}, Away=${team.away_difficulty}`);
    });

    return res.status(200).json({
      success: true,
      message: 'FDR calculated and updated successfully',
      stats: {
        gameweek: currentGW?.name || 'Unknown',
        teams_updated: fdrResults.length,
        duration_seconds: parseFloat(duration)
      },
      sample_ratings: topTeams.map(t => ({
        team: t.team_name,
        home_difficulty: t.home_difficulty,
        away_difficulty: t.away_difficulty,
        home_strength: t.home_strength_score,
        games_played: t.games_played
      }))
    });

  } catch (error) {
    console.error('❌ FDR calculation failed:', error);

    return res.status(500).json({
      success: false,
      error: 'FDR calculation failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

export const config = {
  maxDuration: 30, // seconds
};
