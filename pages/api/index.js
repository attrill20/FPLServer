import fetch from 'isomorphic-unfetch';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Durable fallback, on top of the in-memory cache below: survives cold
// starts and redeploys, so a sustained FPL block doesn't wipe out the last
// known-good response the way the in-memory cache does.
async function getDurableCache(key) {
  const { data, error } = await supabase
    .from('api_cache')
    .select('data')
    .eq('endpoint', key)
    .single();
  if (error) return null;
  return data?.data ?? null;
}

async function setDurableCache(key, data) {
  try {
    const { error } = await supabase
      .from('api_cache')
      .upsert({ endpoint: key, data, updated_at: new Date().toISOString() }, { onConflict: 'endpoint' });
    if (error) console.error('Failed to persist durable cache:', error);
  } catch (error) {
    console.error('Failed to persist durable cache:', error);
  }
}

// In-memory cache: { [cacheKey]: { data, timestamp } }
const cache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  const entry = cache[key];
  if (entry && Date.now() - entry.timestamp < CACHE_TTL_MS) {
    return entry.data;
  }
  return null;
}

// Kept even after CACHE_TTL_MS expiry, as a fallback for when FPL blocks us
// (see fetchWithRetry) - stale data beats a broken app.
function getStale(key) {
  const entry = cache[key];
  return entry ? entry.data : null;
}

function setCache(key, data) {
  cache[key] = { data, timestamp: Date.now() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FPL's API intermittently 403s under load as bot/rate-limit protection
// (not a transient network blip) - a short retry rides out most of these
// without risking Vercel's serverless execution time limit.
async function fetchWithRetry(url, attempts = 2) {
  let lastResponse;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Referer': 'https://fantasy.premierleague.com/'
      }
    });
    if (response.ok) return response;
    lastResponse = response;
    if (response.status === 403 && attempt < attempts) {
      await sleep(1500);
    } else {
      break;
    }
  }
  return lastResponse;
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

      const response = await fetchWithRetry(apiUrl);

      if (!response.ok) {
        console.error('Failed to fetch data, response status:', response.status);

        // FPL is likely bot-blocking us - serve stale data rather than
        // breaking the app if we have anything cached at all. In-memory
        // first (fast), then the durable Supabase cache (survives cold
        // starts and redeploys, which the in-memory cache doesn't).
        const staleData = getStale(cacheKey);
        if (staleData) {
          res.setHeader('X-Cache', 'STALE');
          return res.status(200).json(staleData);
        }

        const durableData = await getDurableCache(cacheKey);
        if (durableData) {
          res.setHeader('X-Cache', 'STALE-DB');
          return res.status(200).json(durableData);
        }

        return res.status(response.status).json({ error: 'Failed to fetch data' });
      }

      const responseData = await response.json();

      // Store in both caches
      setCache(cacheKey, responseData);
      await setDurableCache(cacheKey, responseData);

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
