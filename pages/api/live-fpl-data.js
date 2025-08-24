import fetch from 'node-fetch';

export default async function handler(req, res) {
  const { gameweek } = req.query;

  if (!gameweek) {
    return res.status(400).json({ error: 'Gameweek parameter is required.' });
  }

  try {
    const response = await fetch(`https://fantasy.premierleague.com/api/event/${gameweek}/live/`);
    if (!response.ok) {
      throw new Error(`Failed to fetch data from FPL API: ${response.statusText}`);
    }
    const data = await response.json();
    res.status(200).json(data);
  } catch (error) {
    console.error('Error in live-fpl-data API route:', error);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
}