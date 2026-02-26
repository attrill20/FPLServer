import fetch from 'isomorphic-unfetch';

// In-memory cache: { [cacheKey]: { data, timestamp } }
const cache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.data;
  }
  // Clean up expired entry
  if (entry) delete cache[key];
  return null;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

export default async (req, res) => {
  // Add CORS headers to allow cross-origin requests
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,OPTIONS,PATCH,DELETE,POST,PUT'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const { endpoint, playerId } = req.query;

    try {
      let apiUrl;

      if (endpoint === 'element-summary' && playerId) {
        apiUrl = `https://fantasy.premierleague.com/api/element-summary/${playerId}/`;
      } else {
        apiUrl = `https://fantasy.premierleague.com/api/${endpoint}`;
      }

      // Check cache first
      const cacheKey = apiUrl;
      const cachedData = getCached(cacheKey);
      if (cachedData) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cachedData);
      }

      const response = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
          'Referer': 'https://fantasy.premierleague.com/'
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch data, response status:', response.status);
        return res.status(response.status).json({ error: 'Failed to fetch data' });
      }

      const responseData = await response.json();

      // Store in cache
      setCache(cacheKey, responseData);

      res.setHeader('X-Cache', 'MISS');
      res.status(200).json(responseData);

    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).json({ error: 'Something went wrong' });
    }
  } else {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
};
