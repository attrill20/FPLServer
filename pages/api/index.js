import fetch from 'isomorphic-unfetch';

export default async (req, res) => {
  // Add CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins, adjust as needed
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS,PATCH,DELETE,POST,PUT'
  );

  console.log('Received request:', req.method, req.url); // Log the request method and URL

  if (req.method === 'GET') {
    const { endpoint, playerId } = req.query;
    console.log('Endpoint requested:', endpoint); // Log the requested endpoint

    try {
      let responseData;
      let apiUrl;

      // Handle element-summary endpoint with player ID
      if (endpoint === 'element-summary' && playerId) {
        apiUrl = `https://fantasy.premierleague.com/api/element-summary/${playerId}/`;
      } else {
        apiUrl = `https://fantasy.premierleague.com/api/${endpoint}`;
      }

      // Fetch data based on the specified endpoint with browser-like headers
      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
          'Referer': 'https://fantasy.premierleague.com/'
        }
      });

      // Check if the response is okay
      if (!response.ok) {
        console.error('Failed to fetch data, response status:', response.status); // Log the error response status
        return res.status(response.status).json({ error: 'Failed to fetch data' });
      }

      responseData = await response.json();
      console.log('Fetched data successfully:', responseData); // Log the fetched data

      // Send back the fetched data as the API response
      res.status(200).json(responseData);

    } catch (error) {
      console.error('Error fetching data:', error); // Log the caught error
      res.status(500).json({ error: 'Something went wrong' });
    }
  } else {
    // Handle any other methods (like OPTIONS for preflight requests)
    console.warn('Method not allowed:', req.method); // Log a warning for disallowed methods
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
};
