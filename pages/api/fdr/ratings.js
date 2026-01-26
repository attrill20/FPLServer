/**
 * GET /api/fdr/ratings
 *
 * Returns current FDR ratings for all teams
 * Public endpoint used by frontend
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

  try {
    // Fetch latest ratings from teams table
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, name, short_name, code, home_difficulty, away_difficulty, updated_at')
      .order('name');

    if (error) {
      throw new Error(`Failed to fetch ratings: ${error.message}`);
    }

    // Check if data is stale (>1 hour old)
    const latestUpdate = teams[0]?.updated_at;
    const ONE_HOUR = 60 * 60 * 1000;
    const isStale = !latestUpdate || (Date.now() - new Date(latestUpdate).getTime()) > ONE_HOUR;

    // Format for frontend compatibility
    const ratings = teams.map(team => ({
      id: team.id,
      name: team.name,
      short_name: team.short_name,
      code: team.code,
      h_diff: team.home_difficulty || 5,
      a_diff: team.away_difficulty || 5
    }));

    // Trigger background FDR calculation if data is stale (fire-and-forget)
    if (isStale && process.env.ADMIN_TOKEN) {
      const baseUrl = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : 'http://localhost:3000';

      fetch(`${baseUrl}/api/fdr/calculate`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }).catch(err => {
        console.error('Background FDR update failed:', err.message);
        // Don't fail main request - this is background work
      });
    }

    return res.status(200).json({
      success: true,
      teams: ratings,
      updated_at: teams[0]?.updated_at || null,
      count: teams.length
    });

  } catch (error) {
    console.error('Failed to fetch FDR ratings:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to fetch FDR ratings',
      message: error.message
    });
  }
}
