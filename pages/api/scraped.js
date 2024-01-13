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
  const browser = await puppeteer.launch({
    headless: true,
    // executablePath: '/path/to/chrome', 
  });
  
  const page = await browser.newPage();
  
  try {
    await page.goto('https://understat.com/league/EPL');
    await page.waitForSelector('td.align-right.nowrap');

    const teamNameElements = await page.$$('#league-chemp tbody tr td:nth-child(2) a');
    const xGElements = await page.$$('td.align-right.nowrap');
    
    const xG = [];
    const xGA = [];

    for (let index = 0; index < teamNameElements.length; index++) {
      const teamName = await page.evaluate(el => el.innerText, teamNameElements[index]);

      // Initialize xGParsedValue and xGAParsedValue
      let xGParsedValue = null;
      let xGAParsedValue = null;

      // Parse xG value
      const xGRawValueHandle = xGElements[index * 3];
      
      if (xGRawValueHandle) {
        const xGRawValue = await page.evaluate(el => el.innerText, xGRawValueHandle);
        const xGMatch = xGRawValue.match(/(-?\d+(\.\d+)?)(?:[\+\-]\d+(\.\d+)?)?/);
        const xGNumericValue = xGMatch ? parseFloat(xGMatch[1]) : null;
        xGParsedValue = isNaN(xGNumericValue) ? null : xGNumericValue;
      } else {
        console.error('Could not find xG element at index:', index * 3);
      }

      // Parse xGA value
      const xGARawValueHandle = xGElements[(index * 3) + 1];

      if (xGARawValueHandle) {
        const xGARawValue = await page.evaluate(el => el.innerText, xGARawValueHandle);
        const xGAMatch = xGARawValue.match(/(-?\d+(\.\d+)?)(?:[\+\-]\d+(\.\d+)?)?/);
        const xGANumericValue = xGAMatch ? parseFloat(xGAMatch[1]) : null;
        xGAParsedValue = isNaN(xGANumericValue) ? null : xGANumericValue;
      } else {
        console.error('Could not find xGA element at index:', (index * 3) + 1);
      }

      // Push an object to the xG array for each team name
      xG.push({ teamName, xG: xGParsedValue });

      // Push an object to the xGA array for each team name, starting from the second value
      xGA.push({ teamName, xGA: xGAParsedValue });
    }

    const finalOutput = xG.map((team, index) => ({
      teamName: team.teamName,
      xG: team.xG,
      xGA: xGA[index].xGA,
    }));

    return finalOutput;
  } catch (error) {
    console.log('Error scraping data from the website:', error);
    return null;
  } finally {
    await browser.close();
  }
}

scrapeData();
