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

    console.log('⚡ Triggering QUICK sync (recent players + FDR)...');

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
