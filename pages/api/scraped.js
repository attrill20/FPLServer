// pages/api/scrapedData.js
import puppeteer from 'puppeteer';

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');

  try {
    // Call Puppeteer script to scrape additional data
    const scrapedData = await scrapeData();
    res.status(200).json(scrapedData);
  } catch (error) {
    console.error('Error fetching scraped data:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};

async function scrapeData() {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  try {
    await page.goto('https://understat.com/league/EPL');
    await page.waitForSelector('td.align-right.nowrap');

    const teamNameElements = await page.$$('#league-chemp tbody tr td:nth-child(2) a');
    const xGElements = await page.$$('td.align-right.nowrap');
    const xG = [];
    const xGA = [];

    for (let index = 0; index < teamNameElements.length; index++) {
      const teamName = await teamNameElements[index].innerText();

      // Parse xG value
      const xGRawValue = await xGElements[index * 3].innerText();
      const xGMatch = xGRawValue.match(/(-?\d+(\.\d+)?)(?:[\+\-]\d+(\.\d+)?)?/);
      const xGNumericValue = xGMatch ? xGMatch[1] : null;
      const xGParsedValue = xGNumericValue ? parseFloat(xGNumericValue) : null;

      // Parse xGA value
      const xGARawValue = await xGElements[(index * 3) + 1].innerText();
      const xGAMatch = xGARawValue.match(/(-?\d+(\.\d+)?)(?:[\+\-]\d+(\.\d+)?)?/);
      const xGANumericValue = xGAMatch ? xGAMatch[1] : null;
      const xGAParsedValue = xGANumericValue ? parseFloat(xGANumericValue) : null;

      // Push an object to the xG array for each team name
      xG.push({ teamName, xG: xGParsedValue });

      // Push an object to the xGA array for each team name, starting from the second value
      xGA.push({ teamName, xGA: xGAParsedValue });
    }

    return { xG, xGA };
  } catch (error) {
    console.error('Error scraping data from website:', error);
    return null;
  } finally {
    await browser.close();
  }
}
