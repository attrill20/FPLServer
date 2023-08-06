// pages/api/index.js
import fetch from 'isomorphic-unfetch';

export default async (req, res) => {
// Add CORS headers to allow cross-origin requests
res.setHeader('Access-Control-Allow-Credentials', true);
res.setHeader('Access-Control-Allow-Origin', '*');
 // Add new frontend domains here 
res.setHeader(
  'Access-Control-Allow-Methods',
  'GET,OPTIONS,PATCH,DELETE,POST,PUT'
  );

  try {
    const bootstrapResponse = await fetch(
      'https://fantasy.premierleague.com/api/bootstrap-static/'
    );
    const bootstrapData = await bootstrapResponse.json();

    const fixturesResponse = await fetch(
      'https://fantasy.premierleague.com/api/fixtures/'
    );
    const fixturesData = await fixturesResponse.json();

    const responseData = {
      bootstrapData: bootstrapData,
      fixturesData: fixturesData,
    };

    res.status(200).json(responseData);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};
