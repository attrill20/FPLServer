/**
 * Shared helpers for translating FPL API ids into our stable DB ids.
 *
 * FPL resets `element` (player) and team ids every season on promotion/relegation
 * and squad changes — only `code` is guaranteed stable across seasons. These
 * helpers keep our `players.id` / `teams.id` / `gameweeks.id` stable over time by
 * always matching on `code` (players/teams) or `season_id + round number`
 * (gameweeks), never on FPL's raw per-season id.
 */

/**
 * Supabase/PostgREST caps a plain `.select()` at 1000 rows, so any table that
 * can grow past that (like `players`, across seasons + mid-season transfers)
 * needs explicit pagination or rows silently go missing from the result.
 */
export async function selectAll(supabase, table, columns) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (error) throw new Error(`Failed to load ${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < pageSize) break;
  }
  return rows;
}

export async function getCurrentSeason(supabase) {
  const { data, error } = await supabase
    .from('seasons')
    .select('id, name')
    .eq('is_current', true)
    .single();
  if (error || !data) throw new Error('No current season found');
  return data;
}

/**
 * Syncs the teams table, matching by FPL's stable `code`. Newly promoted teams
 * get a fresh id; continuing teams keep their existing id.
 * Returns a Map from this season's FPL team id -> our teams.id.
 */
export async function syncTeams(supabase, bootstrap) {
  const { data: dbTeams, error } = await supabase.from('teams').select('id, code, name, short_name');
  if (error) throw new Error(`Failed to load teams: ${error.message}`);

  const dbTeamByCode = new Map(dbTeams.map(t => [t.code, t]));
  let nextTeamId = Math.max(...dbTeams.map(t => t.id)) + 1;

  const apiTeamIdToOurTeamId = new Map();
  const upserts = [];

  for (const at of bootstrap.teams) {
    const existing = dbTeamByCode.get(at.code);
    if (existing) {
      apiTeamIdToOurTeamId.set(at.id, existing.id);
      if (existing.name !== at.name || existing.short_name !== at.short_name) {
        upserts.push({ id: existing.id, code: at.code, name: at.name, short_name: at.short_name });
      }
    } else {
      const newId = nextTeamId++;
      apiTeamIdToOurTeamId.set(at.id, newId);
      upserts.push({ id: newId, code: at.code, name: at.name, short_name: at.short_name });
    }
  }

  if (upserts.length) {
    const { error: upsertError } = await supabase.from('teams').upsert(upserts, { onConflict: 'id' });
    if (upsertError) throw new Error(`Failed to sync teams: ${upsertError.message}`);
  }

  return apiTeamIdToOurTeamId;
}

/** Returns a Map from FPL's stable player `code` -> our players.id */
export async function getPlayerIdByCode(supabase) {
  const data = await selectAll(supabase, 'players', 'id, code');
  return new Map(data.map(p => [p.code, p.id]));
}

/**
 * Read-only version of team-id translation for endpoints that run after
 * players.js has already discovered/created any newly promoted teams.
 * Returns a Map from this season's FPL team id -> our teams.id.
 */
export async function getTeamIdByApiId(supabase, bootstrap) {
  const { data, error } = await supabase.from('teams').select('id, code');
  if (error) throw new Error(`Failed to load teams: ${error.message}`);
  const dbTeamByCode = new Map(data.map(t => [t.code, t.id]));
  const map = new Map();
  for (const at of bootstrap.teams) {
    const ourId = dbTeamByCode.get(at.code);
    if (ourId) map.set(at.id, ourId);
  }
  return map;
}

/** Extracts the round number from a gameweek name like "Gameweek 5" -> 5 */
export function parseRoundNumber(gameweekName) {
  const match = gameweekName.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/** Returns a Map from this season's FPL gameweek round number -> our gameweeks.id */
export async function getGameweekIdByRound(supabase, seasonId) {
  const { data, error } = await supabase.from('gameweeks').select('id, name').eq('season_id', seasonId);
  if (error) throw new Error(`Failed to load gameweeks: ${error.message}`);
  const map = new Map();
  for (const gw of data) {
    const match = gw.name.match(/(\d+)/);
    if (match) map.set(parseInt(match[1], 10), gw.id);
  }
  return map;
}
