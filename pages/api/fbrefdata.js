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
    const xgDataMap = new Map();

    $("table.stats_table tbody tr").each((index, element) => {
      let team = $(element).find("th[data-stat='team']").text().trim();
      const xG = parseFloat($(element).find("td.right.group_start[data-stat='xg']").text().trim()) || 0;
      const xGC = parseFloat($(element).find("td.right.modified.group_start[data-stat='xg']").text().trim()) || 0;

      // Remove "vs " prefix if it exists
      if (team.startsWith("vs ")) {
        team = team.slice(3).trim();
      }

      if (team) {
        if (xgDataMap.has(team)) {
          const existingData = xgDataMap.get(team);
          xgDataMap.set(team, {
            team,
            xG: existingData.xG || xG,
            xGC: existingData.xGC || xGC,
          });
        } else {
          xgDataMap.set(team, { team, xG, xGC });
        }
      }
    });

    const xgData = Array.from(xgDataMap.values());

    return res.status(200).json(xgData);
  } catch (error) {
    console.error("Error fetching xG data:", error);
    return res.status(500).json({ error: "Failed to fetch xG data" });
  }
}
