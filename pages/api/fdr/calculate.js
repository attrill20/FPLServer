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
    // Step 0: Check staleness (skip if data is fresh)
    const { data: currentGW } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('is_current', true)
      .single();

    const { data: lastCalc } = await supabase
      .from('team_fdr_calculations')
      .select('calculation_timestamp, gameweek_calculated')
      .order('calculation_timestamp', { ascending: false })
      .limit(1)
      .single();

    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();
    const lastCalcTime = lastCalc ? new Date(lastCalc.calculation_timestamp).getTime() : 0;
    const timeSinceLastCalc = now - lastCalcTime;

    const isStale = !lastCalc ||
                    lastCalc.gameweek_calculated !== currentGW?.id ||
                    timeSinceLastCalc > ONE_HOUR;

    if (!isStale) {
      console.log(`⏭️  FDR is up to date (last calculated ${Math.round(timeSinceLastCalc / 60000)} minutes ago)`);
      return res.status(200).json({
        success: true,
        message: 'FDR is up to date',
        skipped: true,
        last_calculation: lastCalc.calculation_timestamp,
        minutes_since_update: Math.round(timeSinceLastCalc / 60000)
      });
    }

    console.log(`  ℹ️  Data is stale (${Math.round(timeSinceLastCalc / 60000)} minutes old), recalculating...`);

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

    // Step 2: Get current season

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
        // Simplified metrics: goals scored only (home/away split)
        home_goals_scored_per_90: team.home_goals_scored_per_90 || 0,
        home_goals_scored_per_90_score: team.home_goals_scored_per_90_score || 5,
        away_goals_scored_per_90: team.away_goals_scored_per_90 || 0,
        away_goals_scored_per_90_score: team.away_goals_scored_per_90_score || 5,
        // Final ratings (1-10) - currently same as goals scores
        home_difficulty: team.home_difficulty || 5,
        away_difficulty: team.away_difficulty || 5,
        calculation_timestamp: new Date().toISOString()
      }));

      const { error: insertError } = await supabase
        .from('team_fdr_calculations')
        .upsert(calculationRecords, {
          onConflict: 'team_id' // Changed: now one row per team (not per gameweek)
        });

      if (insertError) {
        console.error('  ⚠ Failed to store calculations:', insertError.message);
        // Don't fail the whole operation - ratings can still be updated
      } else {
        console.log(`  ✓ Stored ${calculationRecords.length} calculation records`);
      }

      // Step 3.5: Validate all 20 teams present and backfill if needed
      console.log('  → Validating 20 teams present...');
      const { data: allTeams } = await supabase
        .from('teams')
        .select('id')
        .order('id')
        .limit(20);

      const { data: calculatedTeams } = await supabase
        .from('team_fdr_calculations')
        .select('team_id');

      const missingTeams = allTeams.filter(t =>
        !calculatedTeams.find(c => c.team_id === t.id)
      );

      if (missingTeams.length > 0) {
        console.log(`  ⚠ Backfilling ${missingTeams.length} missing teams with default values`);
        const backfillRecords = missingTeams.map(t => ({
          team_id: t.id,
          season_id: currentSeason.id,
          gameweek_calculated: currentGW.id,
          games_played: 0,
          home_goals_scored_per_90: 0,
          home_goals_scored_per_90_score: 5,
          away_goals_scored_per_90: 0,
          away_goals_scored_per_90_score: 5,
          home_difficulty: 5,
          away_difficulty: 5,
          calculation_timestamp: new Date().toISOString()
        }));

        const { error: backfillError } = await supabase
          .from('team_fdr_calculations')
          .upsert(backfillRecords, { onConflict: 'team_id' });

        if (backfillError) {
          console.error('  ⚠ Backfill failed:', backfillError.message);
        } else {
          console.log(`  ✓ Backfilled ${missingTeams.length} teams`);
        }
      } else {
        console.log(`  ✓ All 20 teams present`);
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
    console.log('   Sample ratings (top 3 by home goals per 90):');
    topTeams.forEach(team => {
      console.log(`   - ${team.team_name}: Home ${team.home_goals_scored_per_90}/90 (rating ${team.home_difficulty}), Away ${team.away_goals_scored_per_90}/90 (rating ${team.away_difficulty})`);
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
        games_played: t.games_played,
        home_goals_per_90: t.home_goals_scored_per_90,
        home_difficulty: t.home_difficulty,
        away_goals_per_90: t.away_goals_scored_per_90,
        away_difficulty: t.away_difficulty
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
