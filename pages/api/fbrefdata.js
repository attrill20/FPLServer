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

    console.log($("#results2025-202691_home_away").length ? "✅ Table found!" : "❌ Table NOT found!");

    const xgDataMap = new Map();

     // Scrape the main stats table
    $("table.stats_table tbody tr").each((index, element) => {
      let team = $(element).find("th[data-stat='team']").text().trim();
       if (team.startsWith("vs ")) {
        team = team.slice(3).trim();   // Remove "vs " prefix if it exists
      }
      
      // Overall Team Stats
      const xg = parseFloat($(element).find("td.right.group_start[data-stat='xg']").text().trim()) || 0;
      const xgc = parseFloat($(element).find("td.right.modified.group_start[data-stat='xg']").text().trim()) || 0;
      // const xg_diff = parseFloat($(element).find("td.right[data-stat='xg_diff']").text().trim().replace(/[+-]/g, "")) || 0;
      // const xg_diff_per90 = parseFloat($(element).find("td.right.group_start[data-stat='xg_diff_per90']").text().trim().replace(/[+-]/g, "")) || 0;

      // Home Stats
      // const home_points_avg = parseFloat($(element).find("td.right.group_start[data-stat='home_points_avg']").text().trim()) || 0;
      // const home_xg = parseFloat($(element).find("td.right.group_start[data-stat='home_xg_for']").text().trim()) || 0;
      // const home_xgc = parseFloat($(element).find("td.right.group_start[data-stat='home_xg_against']").text().trim()) || 0;
      // const home_xg_diff = parseFloat($(element).find("td.right.group_start[data-stat='home_xg_diff']").text().trim()) || 0;
      // const home_xg_diff_per90 = parseFloat($(element).find("td.right.group_start[data-stat='home_xg_diff_per90']").text().trim()) || 0;

      // Away Stats
      // const away_points_avg = parseFloat($(element).find("td.right.group_start[data-stat='away_points_avg']").text().trim()) || 0;
      // const away_xg = parseFloat($(element).find("td.right.group_start[data-stat='away_xg_for']").text().trim()) || 0;
      // const away_xgc = parseFloat($(element).find("td.right.group_start[data-stat='away_xg_against']").text().trim()) || 0;
      // const away_xg_diff = parseFloat($(element).find("td.right.group_start[data-stat='away_xg_diff']").text().trim()) || 0;
      // const away_xg_diff_per90 = parseFloat($(element).find("td.right.group_start[data-stat='away_xg_diff_per90']").text().trim()) || 0;

      if (team) {
        if (xgDataMap.has(team)) {
          const existingData = xgDataMap.get(team);
          xgDataMap.set(team, {
            team,
            xg: existingData.xg || xg,
            xgc: existingData.xgc || xgc,
            // xg_diff: existingData.xg_diff || xg_diff,
            // xg_diff_per90: existingData.xg_diff_per90 || xg_diff_per90,
            home_points_avg: 0,
            // home_xg: existingData.home_xg || home_xg,
            // home_xgc: existingData.home_xgc || home_xgc,
            // home_xg_diff: existingData.home_xg_diff || home_xg_diff,
            // home_xg_diff_per90: existingData.home_xg_diff_per90 || home_xg_diff_per90,
            // away_xg: existingData.away_xg || away_xg,
            // away_xgc: existingData.away_xgc || away_xgc,
            // away_xg_diff: existingData.away_xg_diff || away_xg_diff,
            // away_xg_diff_per90: existingData.away_xg_diff_per90 || away_xg_diff_per90,
            // away_points_avg: existingData.away_points_avg || away_points_avg,
          });
        } else {
          xgDataMap.set(team, {
            team,
            xg,
            xgc,
            // xg_diff,
            // xg_diff_per90,
            // home_xg,
            // home_xgc,
            // home_xg_diff,
            // home_xg_diff_per90,
            home_points_avg : 0,
            // away_xg,
            // away_xgc,
            // away_xg_diff,
            // away_xg_diff_per90,
            // away_points_avg,
          });
        }
      }
    });

    // Scrape the home/away table
    $("#results2025-202691_home_away tbody tr").each((index, element) => {
      console.log($(element).html()); // Check the raw HTML
      let team = $(element).find("th[data-stat='team']").text().trim();

      const home_points_avg = parseFloat($(element).find("td.right[data-stat='home_points_avg']").text().trim()) || 0;

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
