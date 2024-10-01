import fetch from 'isomorphic-unfetch';

export default async (req, res) => {
  // Add CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins, adjust as needed
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS,PATCH,DELETE,POST,PUT'
  );

  if (req.method === 'GET') {
    const { endpoint } = req.query;

    try {
      let responseData;

      // Fetch data based on the specified endpoint
      const response = await fetch(
        `https://fantasy.premierleague.com/api/${endpoint}`
      );

      // Check if the response is okay
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Failed to fetch data' });
      }

      responseData = await response.json();

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
