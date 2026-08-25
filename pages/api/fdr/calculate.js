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

const round2 = (n) => Math.round(n * 100) / 100;

// Prior "weight" (in games) given to the season-start baseline when blending in
// real observed performance for teams calculate_team_fdr() hasn't picked up yet.
// Chosen so a single game nudges the rating slightly rather than swinging it —
// same spirit as the 8-game/5-game recency windows calculate_team_fdr() itself
// uses for established teams.
const BASELINE_PRIOR_GAMES = 6;

function shrinkTowardBaseline(baseline, computed, gamesPlayed, priorGames = BASELINE_PRIOR_GAMES) {
  return (baseline * priorGames + computed * gamesPlayed) / (priorGames + gamesPlayed);
}

async function rateMetric(metric, value) {
  const { data, error } = await supabase.rpc('get_difficulty_rating', {
    raw_value: value,
    metric_name_param: metric
  });
  if (error) throw new Error(`get_difficulty_rating(${metric}) failed: ${error.message}`);
  return data;
}

/** Converts a stats row (total_goals/total_xg/total_goals_conceded/total_xgc/games_played) into attack/defense/difficulty scores via the shared benchmarks. */
async function scoreStats(stats) {
  const perNinety = (total) => total / stats.games_played;
  const goalsPer90 = perNinety(stats.total_goals);
  const xgPer90 = perNinety(stats.total_xg);
  const concededPer90 = perNinety(stats.total_goals_conceded);
  const xgcPer90 = perNinety(stats.total_xgc);

  const [goalsScore, xgScore, concededScore, xgcScore] = await Promise.all([
    rateMetric('goals_per_90', goalsPer90),
    rateMetric('xg_per_90', xgPer90),
    rateMetric('goals_conceded_per_90', concededPer90),
    rateMetric('xgc_per_90', xgcPer90),
  ]);

  const attack = (goalsScore + xgScore) / 2;
  const defense = (concededScore + xgcScore) / 2;
  return { attack, defense, difficulty: (attack + defense) / 2, goalsPer90, xgPer90, concededPer90, xgcPer90, goalsScore, xgScore, concededScore, xgcScore };
}

/**
 * For a team calculate_team_fdr() doesn't yet return a rating for (newly
 * promoted clubs with too little history to clear whatever sample-size floor
 * it requires), compute a lightweight bridge rating directly from their real
 * per-90 stats so far via the same get_difficulty_rating() benchmarks the main
 * calculation uses, shrunk toward the season-start baseline by games played.
 *
 * Blends in the team's overall (both-venues) form so a result at one venue
 * also nudges the other — a team that's playing well should look a little
 * scarier away too, not just at the venue where they've actually played —
 * but at half the weight of a direct same-venue observation, and pure overall
 * form (no venue-specific blend) when there's no data at this venue at all.
 */
async function computeBridgeRating(teamId, venueStats, overallStats, baseline) {
  const overall = overallStats.find(s => s.team_id === teamId);
  if (!overall || !overall.games_played) {
    return { difficulty: baseline, attack: baseline, defense: baseline, raw: null };
  }
  const overallScore = await scoreStats(overall);

  const venue = venueStats.find(s => s.team_id === teamId);
  if (!venue || !venue.games_played) {
    // No data at this specific venue — lean on overall form only, and shrink
    // more conservatively (double the prior) since it's an indirect signal.
    return {
      difficulty: shrinkTowardBaseline(baseline, overallScore.difficulty, overall.games_played, BASELINE_PRIOR_GAMES * 2),
      attack: shrinkTowardBaseline(baseline, overallScore.attack, overall.games_played, BASELINE_PRIOR_GAMES * 2),
      defense: shrinkTowardBaseline(baseline, overallScore.defense, overall.games_played, BASELINE_PRIOR_GAMES * 2),
      raw: null
    };
  }

  const venueScore = await scoreStats(venue);
  const attack = venueScore.attack * 0.7 + overallScore.attack * 0.3;
  const defense = venueScore.defense * 0.7 + overallScore.defense * 0.3;
  const difficulty = (attack + defense) / 2;

  return {
    difficulty: shrinkTowardBaseline(baseline, difficulty, venue.games_played),
    attack: shrinkTowardBaseline(baseline, attack, venue.games_played),
    defense: shrinkTowardBaseline(baseline, defense, venue.games_played),
    raw: { goalsPer90: venueScore.goalsPer90, xgPer90: venueScore.xgPer90, concededPer90: venueScore.concededPer90, xgcPer90: venueScore.xgcPer90, goalsScore: venueScore.goalsScore, xgScore: venueScore.xgScore, concededScore: venueScore.concededScore, xgcScore: venueScore.xgcScore, gamesPlayed: venue.games_played }
  };
}

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
    // Step 0: Get current gameweek
    const { data: currentGW } = await supabase
      .from('gameweeks')
      .select('id, name')
      .eq('is_current', true)
      .single();

    if (!currentGW) {
      console.log('ℹ️  No current gameweek — skipping FDR calculation (between seasons or before the first deadline)');
      return res.status(200).json({
        success: true,
        skipped: true,
        message: 'No current gameweek — skipping FDR calculation'
      });
    }

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
        home_games: team.home_games || 0,
        away_games: team.away_games || 0,
        // Final difficulty ratings (1-10, can be decimal like 7.5)
        home_difficulty: team.home_difficulty || 5.0,
        away_difficulty: team.away_difficulty || 5.0,
        // Attack/Defense sub-ratings
        home_attack_rating: team.home_attack_rating || 5.0,
        away_attack_rating: team.away_attack_rating || 5.0,
        home_defense_rating: team.home_defense_rating || 5.0,
        away_defense_rating: team.away_defense_rating || 5.0,
        // Goals scored metrics (home/away split)
        home_goals_scored_per_90: team.home_goals_scored_per_90 || 0,
        home_goals_scored_per_90_score: team.home_goals_scored_per_90_score || 5,
        away_goals_scored_per_90: team.away_goals_scored_per_90 || 0,
        away_goals_scored_per_90_score: team.away_goals_scored_per_90_score || 5,
        // Goals conceded metrics (home/away split)
        home_goals_conceded_per_90: team.home_goals_conceded_per_90 || 0,
        home_goals_conceded_per_90_score: team.home_goals_conceded_per_90_score || 5,
        away_goals_conceded_per_90: team.away_goals_conceded_per_90 || 0,
        away_goals_conceded_per_90_score: team.away_goals_conceded_per_90_score || 5,
        // xG metrics (home/away split)
        home_xg_per_90: team.home_xg_per_90 || 0,
        home_xg_per_90_score: team.home_xg_per_90_score || 5,
        away_xg_per_90: team.away_xg_per_90 || 0,
        away_xg_per_90_score: team.away_xg_per_90_score || 5,
        // xGC metrics (home/away split)
        home_xgc_per_90: team.home_xgc_per_90 || 0,
        home_xgc_per_90_score: team.home_xgc_per_90_score || 5,
        away_xgc_per_90: team.away_xgc_per_90 || 0,
        away_xgc_per_90_score: team.away_xgc_per_90_score || 5,
        // Form metrics (combined recent form)
        recent_form: team.recent_form || 0,
        recent_form_score: team.recent_form_score || 5,
        // PPG recent metrics (points from last 5 home/away games)
        home_ppg_recent: team.home_ppg_recent || 0,
        home_ppg_recent_score: team.home_ppg_recent_score || 5,
        away_ppg_recent: team.away_ppg_recent || 0,
        away_ppg_recent_score: team.away_ppg_recent_score || 5,
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

      // Step 3.2: Store weekly snapshot for movers tracking
      console.log('  → Storing weekly FDR snapshot...');
      const snapshotRecords = fdrResults.map(team => ({
        team_id: team.team_id,
        gameweek_id: currentGW.id,
        season_id: currentSeason.id,
        home_difficulty: team.home_difficulty || 5.0,
        away_difficulty: team.away_difficulty || 5.0,
        home_goals_scored_per_90: team.home_goals_scored_per_90 || 0,
        home_goals_conceded_per_90: team.home_goals_conceded_per_90 || 0,
        away_goals_scored_per_90: team.away_goals_scored_per_90 || 0,
        away_goals_conceded_per_90: team.away_goals_conceded_per_90 || 0,
        home_xg_per_90: team.home_xg_per_90 || 0,
        home_xgc_per_90: team.home_xgc_per_90 || 0,
        away_xg_per_90: team.away_xg_per_90 || 0,
        away_xgc_per_90: team.away_xgc_per_90 || 0,
        recent_form: team.recent_form || 0,
        recent_form_score: team.recent_form_score || 0,
        home_ppg_recent: team.home_ppg_recent || 0,
        home_ppg_recent_score: team.home_ppg_recent_score || 0,
        away_ppg_recent: team.away_ppg_recent || 0,
        away_ppg_recent_score: team.away_ppg_recent_score || 0,
        updated_at: new Date().toISOString()
      }));

      const { error: snapshotError } = await supabase
        .from('fdr_weekly_snapshots')
        .upsert(snapshotRecords, { onConflict: 'team_id,gameweek_id' });

      if (snapshotError) {
        console.error('  ⚠ Failed to store weekly snapshot:', snapshotError.message);
      } else {
        console.log(`  ✓ Stored ${snapshotRecords.length} weekly snapshot records for GW ${currentGW.name}`);
      }

      // Step 3.5: Validate every team is present and backfill if needed.
      // calculate_team_fdr() only returns teams with enough historical data to
      // compute a rating from — newly promoted teams (assigned fresh ids beyond
      // the original 20 by syncTeams) never appear in its output, so this must
      // check against the *actual* team roster, not a hardcoded count.
      console.log('  → Validating all teams present...');
      const { data: allTeams } = await supabase
        .from('teams')
        .select('id')
        .order('id');

      const { data: calculatedTeams } = await supabase
        .from('team_fdr_calculations')
        .select('team_id');

      const missingTeams = allTeams.filter(t =>
        !calculatedTeams.find(c => c.team_id === t.id)
      );

      if (missingTeams.length > 0) {
        // Season-start baseline for teams with no computed rating yet (typically
        // newly promoted clubs): home 3.0 / away 2.0, reflecting an easier-than-
        // average opponent. Once they've actually played, blend in their real
        // per-90 numbers (via computeBridgeRating) rather than leaving them
        // static — a team that wins should nudge upward, one that loses down,
        // even before calculate_team_fdr() itself starts covering them.
        console.log(`  ⚠ Computing bridge ratings for ${missingTeams.length} team(s) calculate_team_fdr() hasn't picked up yet`);

        const [
          { data: homeStats, error: homeStatsError },
          { data: awayStats, error: awayStatsError },
          { data: overallStats, error: overallStatsError }
        ] = await Promise.all([
          supabase.rpc('get_team_home_stats'),
          supabase.rpc('get_team_away_stats'),
          supabase.rpc('get_team_xg_stats'),
        ]);
        if (homeStatsError) console.error('  ⚠ get_team_home_stats failed:', homeStatsError.message);
        if (awayStatsError) console.error('  ⚠ get_team_away_stats failed:', awayStatsError.message);
        if (overallStatsError) console.error('  ⚠ get_team_xg_stats failed:', overallStatsError.message);

        const backfillRecords = [];
        const teamsBackfill = [];

        for (const t of missingTeams) {
          const home = await computeBridgeRating(t.id, homeStats || [], overallStats || [], 3.0);
          const away = await computeBridgeRating(t.id, awayStats || [], overallStats || [], 2.0);

          backfillRecords.push({
            team_id: t.id,
            season_id: currentSeason.id,
            gameweek_calculated: currentGW.id,
            games_played: (home.raw?.gamesPlayed || 0) + (away.raw?.gamesPlayed || 0),
            home_games: home.raw?.gamesPlayed || 0,
            away_games: away.raw?.gamesPlayed || 0,
            home_difficulty: round2(home.difficulty),
            away_difficulty: round2(away.difficulty),
            home_attack_rating: round2(home.attack),
            away_attack_rating: round2(away.attack),
            home_defense_rating: round2(home.defense),
            away_defense_rating: round2(away.defense),
            home_goals_scored_per_90: round2(home.raw?.goalsPer90 || 0),
            home_goals_scored_per_90_score: home.raw ? Math.round(home.raw.goalsScore) : 5,
            away_goals_scored_per_90: round2(away.raw?.goalsPer90 || 0),
            away_goals_scored_per_90_score: away.raw ? Math.round(away.raw.goalsScore) : 5,
            home_goals_conceded_per_90: round2(home.raw?.concededPer90 || 0),
            home_goals_conceded_per_90_score: home.raw ? Math.round(home.raw.concededScore) : 5,
            away_goals_conceded_per_90: round2(away.raw?.concededPer90 || 0),
            away_goals_conceded_per_90_score: away.raw ? Math.round(away.raw.concededScore) : 5,
            home_xg_per_90: round2(home.raw?.xgPer90 || 0),
            home_xg_per_90_score: home.raw ? Math.round(home.raw.xgScore) : 5,
            away_xg_per_90: round2(away.raw?.xgPer90 || 0),
            away_xg_per_90_score: away.raw ? Math.round(away.raw.xgScore) : 5,
            home_xgc_per_90: round2(home.raw?.xgcPer90 || 0),
            home_xgc_per_90_score: home.raw ? Math.round(home.raw.xgcScore) : 5,
            away_xgc_per_90: round2(away.raw?.xgcPer90 || 0),
            away_xgc_per_90_score: away.raw ? Math.round(away.raw.xgcScore) : 5,
            // Form/PPG need multi-gameweek history we don't have a per-team RPC
            // for yet — leave at neutral until calculate_team_fdr() takes over.
            recent_form: 0,
            recent_form_score: 5,
            home_ppg_recent: 0,
            home_ppg_recent_score: 5,
            away_ppg_recent: 0,
            away_ppg_recent_score: 5,
            calculation_timestamp: new Date().toISOString()
          });

          teamsBackfill.push({
            id: t.id,
            home_difficulty: round2(home.difficulty),
            away_difficulty: round2(away.difficulty),
            home_attack_rating: round2(home.attack),
            away_attack_rating: round2(away.attack),
            home_defense_rating: round2(home.defense),
            away_defense_rating: round2(away.defense),
            updated_at: new Date().toISOString()
          });
        }

        const { error: backfillError } = await supabase
          .from('team_fdr_calculations')
          .upsert(backfillRecords, { onConflict: 'team_id' });

        if (backfillError) {
          console.error('  ⚠ Backfill failed:', backfillError.message);
        } else {
          console.log(`  ✓ Backfilled ${missingTeams.length} teams`);

          // Also push the same ratings onto the teams table directly — Step 4
          // below only updates teams present in fdrResults, so without this a
          // backfilled team's home_difficulty/away_difficulty would stay null.
          // Must be .update() per row, not .upsert() — an upsert's insert path
          // still validates NOT NULL columns (code/name/short_name) even when
          // it's only ever going to hit the update branch for an existing id.
          const teamsBackfillResults = await Promise.all(
            teamsBackfill.map(({ id, ...fields }) =>
              supabase.from('teams').update(fields).eq('id', id)
            )
          );
          const teamsBackfillError = teamsBackfillResults.find(r => r.error)?.error;
          if (teamsBackfillError) {
            console.error('  ⚠ Teams table backfill failed:', teamsBackfillError.message);
          }

          // Also write a weekly snapshot for these teams — Step 3.2 above only
          // covers fdrResults, so without this a backfilled team would never
          // get a baseline for next week's mover comparison to diff against.
          const snapshotBackfill = backfillRecords.map(r => ({
            team_id: r.team_id,
            gameweek_id: currentGW.id,
            season_id: currentSeason.id,
            home_difficulty: r.home_difficulty,
            away_difficulty: r.away_difficulty,
            home_goals_scored_per_90: r.home_goals_scored_per_90,
            home_goals_conceded_per_90: r.home_goals_conceded_per_90,
            away_goals_scored_per_90: r.away_goals_scored_per_90,
            away_goals_conceded_per_90: r.away_goals_conceded_per_90,
            home_xg_per_90: r.home_xg_per_90,
            home_xgc_per_90: r.home_xgc_per_90,
            away_xg_per_90: r.away_xg_per_90,
            away_xgc_per_90: r.away_xgc_per_90,
            recent_form: r.recent_form,
            recent_form_score: r.recent_form_score,
            home_ppg_recent: r.home_ppg_recent,
            home_ppg_recent_score: r.home_ppg_recent_score,
            away_ppg_recent: r.away_ppg_recent,
            away_ppg_recent_score: r.away_ppg_recent_score,
            updated_at: new Date().toISOString()
          }));
          const { error: snapshotBackfillError } = await supabase
            .from('fdr_weekly_snapshots')
            .upsert(snapshotBackfill, { onConflict: 'team_id,gameweek_id' });
          if (snapshotBackfillError) {
            console.error('  ⚠ Snapshot backfill failed:', snapshotBackfillError.message);
          }
        }
      } else {
        console.log('  ✓ All teams present');
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
          home_attack_rating: team.home_attack_rating || 5.0,
          away_attack_rating: team.away_attack_rating || 5.0,
          home_defense_rating: team.home_defense_rating || 5.0,
          away_defense_rating: team.away_defense_rating || 5.0,
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
      console.log(`   - ${team.team_name}:`);
      console.log(`     Home: ${team.home_goals_scored_per_90} GF/90 (${team.home_goals_scored_per_90_score}), ${team.home_goals_conceded_per_90} GC/90 (${team.home_goals_conceded_per_90_score}), ${team.home_xg_per_90} xG/90 (${team.home_xg_per_90_score}), Form: ${team.recent_form} (${team.recent_form_score}), PPG: ${team.home_ppg_recent} (${team.home_ppg_recent_score}) → Diff: ${team.home_difficulty}`);
      console.log(`     Away: ${team.away_goals_scored_per_90} GF/90 (${team.away_goals_scored_per_90_score}), ${team.away_goals_conceded_per_90} GC/90 (${team.away_goals_conceded_per_90_score}), ${team.away_xg_per_90} xG/90 (${team.away_xg_per_90_score}), Form: ${team.recent_form} (${team.recent_form_score}), PPG: ${team.away_ppg_recent} (${team.away_ppg_recent_score}) → Diff: ${team.away_difficulty}`);
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
        home_games: t.home_games,
        away_games: t.away_games,
        home_goals_scored_per_90: t.home_goals_scored_per_90,
        home_goals_scored_score: t.home_goals_scored_per_90_score,
        home_goals_conceded_per_90: t.home_goals_conceded_per_90,
        home_goals_conceded_score: t.home_goals_conceded_per_90_score,
        home_xg_per_90: t.home_xg_per_90,
        home_xg_score: t.home_xg_per_90_score,
        recent_form: t.recent_form,
        recent_form_score: t.recent_form_score,
        home_difficulty: t.home_difficulty,
        away_goals_scored_per_90: t.away_goals_scored_per_90,
        away_goals_scored_score: t.away_goals_scored_per_90_score,
        away_goals_conceded_per_90: t.away_goals_conceded_per_90,
        away_goals_conceded_score: t.away_goals_conceded_per_90_score,
        away_xg_per_90: t.away_xg_per_90,
        away_xg_score: t.away_xg_per_90_score,
        home_ppg_recent: t.home_ppg_recent,
        home_ppg_recent_score: t.home_ppg_recent_score,
        away_ppg_recent: t.away_ppg_recent,
        away_ppg_recent_score: t.away_ppg_recent_score,
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
