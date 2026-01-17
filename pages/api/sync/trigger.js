/**
 * API Endpoint: /api/sync/trigger
 *
 * Manually triggers a live gameweek sync
 * Useful for testing and manual updates
 *
 * Security: Protected by ADMIN_TOKEN bearer token
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

    console.log('🔄 Manually triggering sync...');

    // Call the live-gameweek sync endpoint
    const syncUrl = `${baseUrl}/api/sync/live-gameweek`;
    const syncResponse = await fetch(syncUrl, {
      method: 'POST',
      headers: {
        'x-vercel-cron-secret': process.env.CRON_SECRET
      }
    });

    const syncResult = await syncResponse.json();

    // Return the sync result
    return res.status(syncResponse.status).json({
      triggered: true,
      sync_result: syncResult,
      triggered_at: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Manual sync trigger failed:', error);

    return res.status(500).json({
      error: 'Failed to trigger sync',
      message: error.message
    });
  }
}
