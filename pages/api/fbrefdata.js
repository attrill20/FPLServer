import fetch from "isomorphic-unfetch";
import * as cheerio from "cheerio";

export default async function handler(req, res) {
  // Allow CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const url = "https://fbref.com/en/comps/9/Premier-League-Stats";
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const html = await response.text();

    const $ = cheerio.load(html);

    const homeAwayTable = $('table[id^="results"][id$="_home_away"]');
    console.log(homeAwayTable.length ? "✅ Home/Away Table found!" : "❌ Home/Away Table NOT found!");

    const xgDataMap = new Map();

    // Scrape the main stats table
    $('#stats_squads_standard_for tbody tr').each((index, element) => {
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

    console.log("Scraped xG Data:", xgData);

    return res.status(200).json(xgData);
  } catch (error) {
    console.error("Error fetching xG data:", error);
    return res.status(500).json({ error: "Failed to fetch xG data" });
  }
}
