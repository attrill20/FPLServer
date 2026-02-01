/**
 * API Endpoint: /api/sync/trigger
 *
 * Triggers QUICK data sync (recent players only) + FDR calculation
 * Called by GitHub Actions hourly OR manually via admin token
 *
 * For full historical sync, use /api/sync/full-stats (run weekly)
 *
 * Security: Protected by ADMIN_TOKEN
 *
 * Example:
 *   POST /api/sync/trigger
 *   Headers: Authorization: Bearer <ADMIN_TOKEN>
 */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: Verify admin token
  const authHeader = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (!authHeader || authHeader !== expectedToken) {
    console.error('Unauthorized sync trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get the base URL for the sync endpoint
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    console.log('⚡ Triggering QUICK sync (players + stats + FDR)...');

    // Step 0: Sync players table first (adds new players, avoids foreign key errors)
    console.log('👥 Syncing players table...');
    const playersUrl = `${baseUrl}/api/sync/players`;
    const playersResponse = await fetch(playersUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });

    const playersResult = await playersResponse.json();

    if (!playersResponse.ok) {
      console.warn('⚠ Players sync failed:', playersResult.message);
      // Continue anyway - most players probably exist
    } else {
      console.log(`✓ Players sync complete (${playersResult.stats?.added || 0} added, ${playersResult.stats?.updated || 0} updated)`);
    }

    // Step 1: Call the quick-stats sync endpoint (recent players only)
    const syncUrl = `${baseUrl}/api/sync/quick-stats`;
    const syncResponse = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });

    const syncResult = await syncResponse.json();

    if (!syncResponse.ok) {
      throw new Error(`Quick sync failed: ${syncResult.message || syncResponse.status}`);
    }

    console.log('✓ Quick sync complete');

    // Step 2: Sync FPL difficulty ratings
    console.log('🎯 Syncing FPL difficulty ratings...');
    const fplDiffUrl = `${baseUrl}/api/sync/fpl-difficulty`;
    const fplDiffResponse = await fetch(fplDiffUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });

    const fplDiffResult = await fplDiffResponse.json();

    if (!fplDiffResponse.ok) {
      console.warn('⚠ FPL difficulty sync failed');
    } else {
      console.log('✓ FPL difficulty sync complete');
    }

    // Step 3: Call the FDR calculation endpoint
    console.log('🎯 Triggering FDR calculation...');
    const fdrUrl = `${baseUrl}/api/fdr/calculate`;
    const fdrResponse = await fetch(fdrUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN}`
      }
    });

    const fdrResult = await fdrResponse.json();

    if (!fdrResponse.ok) {
      console.warn('⚠ FDR calculation failed, but gameweek sync succeeded');
    } else {
      console.log('✓ FDR calculation complete');
    }

    // Return combined result
    return res.status(200).json({
      success: true,
      triggered: true,
      triggered_at: new Date().toISOString(),
      players_result: playersResult,
      sync_result: syncResult,
      fpl_difficulty_result: fplDiffResult,
      fdr_result: fdrResult
    });

  } catch (error) {
    console.error('❌ Sync trigger failed:', error);

    return res.status(500).json({
      success: false,
      error: 'Failed to trigger sync',
      message: error.message
    });
  }
}

export const config = {
  maxDuration: 120, // 2 minutes - needs time for players sync + quick stats + FDR calculation
};
