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
    const response = await fetch(url);
    const html = await response.text();

    const $ = cheerio.load(html);
    const xgData = [];

    $("#stats_squads_standard tbody tr").each((index, element) => {
      const team = $(element).find("th[data-stat='team']").text().trim();
      const xG = $(element).find("td[data-stat='xg_for']").text().trim();
      const xGA = $(element).find("td[data-stat='xg_against']").text().trim();

      if (team) {
        xgData.push({
          team,
          xG: parseFloat(xG) || 0,
          xGA: parseFloat(xGA) || 0,
        });
      }
    });

    return res.status(200).json(xgData);
  } catch (error) {
    console.error("Error fetching xG data:", error);
    return res.status(500).json({ error: "Failed to fetch xG data" });
  }
}
