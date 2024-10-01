import fetch from 'isomorphic-unfetch';

export default async (req, res) => {
  // Add CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Add new frontend domains here if needed
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS,PATCH,DELETE,POST,PUT'
  );
  
  if (req.method === 'GET') {
    const { endpoint, playerId } = req.query;

    try {
      let responseData;

      switch (endpoint) {
        case 'bootstrap-static':
          // Fetch bootstrap data
          const bootstrapResponse = await fetch(
            'https://fantasy.premierleague.com/api/bootstrap-static/'
          );
          responseData = await bootstrapResponse.json();
          break;

        case 'fixtures':
          // Fetch fixtures data
          const fixturesResponse = await fetch(
            'https://fantasy.premierleague.com/api/fixtures/'
          );
          responseData = await fixturesResponse.json();
          break;

        case 'player':
          if (!playerId) {
            return res.status(400).json({ error: 'Player ID is required for player endpoint' });
          }
          // Fetch specific player data from the element-summary endpoint
          const playerResponse = await fetch(
            `https://fantasy.premierleague.com/api/element-summary/${playerId}/`
          );
          responseData = await playerResponse.json();
          break;

        default:
          return res.status(400).json({ error: 'Invalid endpoint specified' });
      }

      // Send back the fetched data as the API response
      res.status(200).json(responseData);

    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).json({ error: 'Something went wrong' });
    }

  } else {
    // Handle any other methods (like OPTIONS for preflight requests)
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
};
