/**
 * API Endpoint: /api/sync/trigger
 *
 * Triggers full data sync: live gameweek sync + FDR calculation
 * Called by Vercel cron every hour OR manually via admin token
 *
 * Security: Protected by CRON_SECRET (cron) or ADMIN_TOKEN (manual)
 *
 * Example:
 *   POST /api/sync/trigger
 *   Headers: Authorization: Bearer <ADMIN_TOKEN>
 *   OR
 *   Headers: x-vercel-cron-secret: <CRON_SECRET>
 */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Security: Verify admin token OR cron secret
  const authHeader = req.headers.authorization;
  const cronSecret = req.headers['x-vercel-cron-secret'];
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  const isAuthorized =
    (authHeader && authHeader === expectedToken) ||
    (cronSecret && cronSecret === process.env.CRON_SECRET);

  if (!isAuthorized) {
    console.error('Unauthorized sync trigger attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Get the base URL for the sync endpoint
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${protocol}://${host}`;

    console.log('🔄 Triggering full sync (gameweek data + FDR)...');

    // Step 1: Call the live-gameweek sync endpoint
    const syncUrl = `${baseUrl}/api/sync/live-gameweek`;
    const syncResponse = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'x-vercel-cron-secret': process.env.CRON_SECRET
      }
    });

    const syncResult = await syncResponse.json();

    if (!syncResponse.ok) {
      throw new Error(`Gameweek sync failed: ${syncResult.message || syncResponse.status}`);
    }

    console.log('✓ Gameweek sync complete');

    // Step 2: Call the FDR calculation endpoint
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
      sync_result: syncResult,
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
