import puppeteer from 'puppeteer-core';
import chrome from 'chrome-aws-lambda';
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  // Allow CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const browser = await puppeteer.launch({
      args: chrome.args,
      executablePath: await chrome.executablePath,
      headless: chrome.headless,
    });
    const page = await browser.newPage();

    const url = "https://fbref.com/en/comps/9/Premier-League-Stats";
    await page.goto(url, { waitUntil: 'networkidle0' });

    const html = await page.content();

    await browser.close();

    const $ = cheerio.load(html);

    const squadsStandardForTable = $('#all_stats_squads_standard_for .stats_table');
    const homeAwayTable = $('#all_results_home_away .stats_table');

    console.log(squadsStandardForTable.length ? "✅ Main Stats Table found!" : "❌ Main Stats Table NOT found!");
    console.log(homeAwayTable.length ? "✅ Home/Away Table found!" : "❌ Home/Away Table NOT found!");

    const xgDataMap = new Map();

    // Scrape the main stats table
    squadsStandardForTable.find('tbody tr').each((index, element) => {
      let team = $(element).find("th[data-stat='team'] a").text().trim();
      if (team.startsWith("vs ")) {
        team = team.slice(3).trim(); // Remove "vs " prefix if it exists
      }

      // Overall Team Stats
      const xg = parseFloat($(element).find("td[data-stat='xg']").text().trim()) || 0;
      const xga = parseFloat($(element).find("td[data-stat='xga']").text().trim()) || 0;

      if (team) {
        xgDataMap.set(team, {
          team,
          xg,
          xga,
          home_points_avg: 0,
        });
      }
    });

    // Scrape the home/away table
    homeAwayTable.find('tbody tr').each((index, element) => {
      let team = $(element).find("th[data-stat='team'] a").text().trim();
      const home_points_avg = parseFloat($(element).find("td[data-stat='home_points_avg']").text().trim()) || 0;

      if (team && xgDataMap.has(team)) {
        let existingData = xgDataMap.get(team);
        existingData.home_points_avg = home_points_avg;
        xgDataMap.set(team, existingData);
      }
    });

    const xgData = Array.from(xgDataMap.values());

    return res.status(200).json(xgData);
  } catch (error) {
    console.log("Error in try block:", error);
    console.error("Error fetching xG data:", error);
    return res.status(500).json({ error: "Failed to fetch xG data" });
  }
}
