// Madden 27 franchise exporter — runs on your PC.
// Reads a COPY of your franchise save (never writes to the real one),
// builds a compact JSON snapshot, saves it locally, and optionally
// uploads it to GitHub so the hosted MCP server can read it.
//
// Usage:
//   node exporter/export.js                 -> uses your newest CAREER- save automatically
//   node exporter/export.js "<save path>"   -> uses a specific save
//   (or set MADDEN_SAVE_PATH in your environment)
//
// Optional upload env vars: GITHUB_TOKEN, GITHUB_REPO (owner/name), GITHUB_BRANCH (default "data")

import Franchise from 'madden-franchise';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OUT_FILE = path.resolve('franchise.json');
const SNAPSHOT_PATH_IN_REPO = 'madden/franchise.json';

// Find the most recently modified franchise save (CAREER-*, not CAREERDRAFT-*).
async function findNewestSave() {
  const home = os.homedir();
  const dirs = [
    process.env.MADDEN_SAVES_DIR,
    path.join(home, 'OneDrive', 'Documents', 'Madden NFL 27', 'saves'),
    path.join(home, 'Documents', 'Madden NFL 27', 'saves')
  ].filter(Boolean);
  for (const dir of dirs) {
    let names;
    try { names = await fs.readdir(dir); } catch { continue; }
    const saves = [];
    for (const n of names.filter((n) => n.startsWith('CAREER-'))) {
      const full = path.join(dir, n);
      saves.push({ full, mtime: (await fs.stat(full)).mtimeMs });
    }
    if (saves.length) return saves.sort((a, b) => b.mtime - a.mtime)[0].full;
  }
  return null;
}

const SAVE_PATH = process.argv[2] || process.env.MADDEN_SAVE_PATH || (await findNewestSave());
if (!SAVE_PATH) {
  console.error('No CAREER- save found. Pass the path to your save file, or set MADDEN_SAVE_PATH / MADDEN_SAVES_DIR.');
  process.exit(1);
}

// Enum fields can come back as a name string or an enum member object.
const enumName = (v) => (v && typeof v === 'object' ? v.name ?? v._name ?? String(v) : v);

// M27's TraitDevelopment enum reuses College Football names. By index:
// Normal=0, College_Impact=1 (Star), College_Star=2 (Superstar), College_Elite=3 (X-Factor).
// Team cap-room fields are stored with a +160000 offset (so negative room fits), in $10k units.
const CAP_ROOM_OFFSET = 160000;
const unoffset = (v) => (v == null ? null : v - CAP_ROOM_OFFSET);

const DEV_MAP = { Normal: 'Normal', College_Impact: 'Star', College_Star: 'Superstar', College_Elite: 'XFactor' };

const RATING_FIELDS = [
  'SpeedRating', 'AccelerationRating', 'AgilityRating', 'StrengthRating', 'AwarenessRating',
  'ThrowPowerRating', 'ThrowAccuracyShortRating', 'ThrowAccuracyMidRating', 'ThrowAccuracyDeepRating',
  'ThrowUnderPressureRating', 'ThrowOnTheRunRating', 'PlayActionRating', 'BreakSackRating',
  'CarryingRating', 'BCVisionRating', 'BreakTackleRating', 'TruckingRating', 'JukeMoveRating',
  'CatchingRating', 'CatchInTrafficRating', 'SpectacularCatchRating', 'ShortRouteRunningRating',
  'MediumRouteRunningRating', 'DeepRouteRunningRating', 'ReleaseRating',
  'PassBlockRating', 'RunBlockRating', 'ImpactBlockingRating', 'LeadBlockRating',
  'TackleRating', 'HitPowerRating', 'PursuitRating', 'PlayRecognitionRating', 'BlockSheddingRating',
  'PowerMovesRating', 'FinesseMovesRating', 'ManCoverageRating', 'ZoneCoverageRating', 'PressRating',
  'KickPowerRating', 'KickAccuracyRating', 'KickReturnRating', 'StaminaRating', 'InjuryRating', 'ToughnessRating'
];

const PLAYER_FIELDS = [
  'FirstName', 'LastName', 'Position', 'Age', 'YearsPro', 'JerseyNum', 'TeamIndex', 'OverallRating',
  'TraitDevelopment', 'ContractStatus', 'Contract', 'PLYR_CAPSALARY', 'PLYR_DRAFTROUND', 'PLYR_DRAFTPICK',
  'InjuryType', 'InjuryStatus', 'InjurySeverity', 'IsInjuredReserve', 'Height', 'Weight',
  ...RATING_FIELDS
];

const TEAM_FIELDS = [
  'TeamIndex', 'DisplayName', 'LongName', 'NickName', 'ShortName', 'IsUserManaged',
  'HomeWin', 'HomeLoss', 'HomeTie', 'RoadWin', 'RoadLoss', 'RoadTie',
  'DivisionWin', 'DivisionLoss', 'ConfWin', 'ConfLoss',
  'SeasonLeagPointsFor', 'SeasonLeagPointsAgainst', 'OffensiveRank', 'DefensiveRank', 'SeasonWinLossStreak',
  'SalCapCapRoom', 'SalCapNextYearCapRoom', 'SalCapRosterSize', 'ThisYearCapPenalties', 'NextYearCapPenalties',
  'ThisYearCapCredits', 'RolloverCap', 'SalCapRosterReserve', 'SalCapSpendingMoney'
];

async function readTable(franchise, name, fields) {
  // Saves can contain several tables with the same name. Read them all and
  // keep the one with the most real records.
  const tables = franchise.getAllTablesByName(name);
  if (!tables.length) throw new Error(`Table "${name}" not found in save`);
  let best = [];
  const counts = [];
  for (const table of tables) {
    try {
      await table.readRecords(fields);
      const recs = table.records.filter((r) => !r.isEmpty);
      counts.push(recs.length);
      if (recs.length > best.length) best = recs;
    } catch (e) {
      counts.push(`err: ${e.message}`);
    }
  }
  if (tables.length > 1) console.log(`  ${name}: ${tables.length} tables found (records: ${counts.join(', ')}), using the largest`);
  return best;
}

const contractStats = { tried: 0, resolved: 0, empty: 0, logged: 0 };
function logContractFail(msg, extra) {
  if (contractStats.logged++ < 3) console.log(`  [contract] ${msg}`, extra ?? '');
}

async function resolveContract(franchise, ref, cache) {
  contractStats.tried++;
  try {
    if (!ref || (typeof ref === 'string' && /^0+$/.test(ref))) { contractStats.empty++; return null; } // free agents have no contract
    // Reference = 32-bit string: first 15 bits are the table id, the rest is the row.
    const tableId = parseInt(ref.slice(0, 15), 2);
    const rowNumber = parseInt(ref.slice(15), 2);
    const refInfo = { tableId, rowNumber };
    let table = cache.get(tableId);
    if (!table) {
      table = franchise.getTableById(tableId);
      if (!table) { logContractFail(`no table for tableId=${tableId}`, JSON.stringify({ refType: typeof ref, ref: String(ref).slice(0, 64), refInfo })); return null; }
      await table.readRecords();
      cache.set(tableId, table);
    }
    const c = table.records[rowNumber];
    if (!c || c.isEmpty) { logContractFail(`empty record at row ${rowNumber} in "${table.name}"`); return null; }
    contractStats.resolved++;
    const salaries = [];
    const bonuses = [];
    for (let i = 0; i < 10; i++) salaries.push(c[`SalaryYear${i}`] ?? null);
    for (let i = 0; i < 7; i++) bonuses.push(c[`BonusYear${i}`] ?? null);
    const length = c.Length ?? null;
    const currentYear = c.CurrentYear ?? null;
    return {
      length,
      currentYear,
      yearsLeft: length != null && currentYear != null ? Math.max(length - currentYear, 0) : null,
      salaryByYear: salaries.slice(0, length ?? 10),
      bonusByYear: bonuses.slice(0, length ?? 7),
      noTradeClause: !!c.NoTradeClause,
      voidYears: c.VoidYears ?? 0
    };
  } catch (e) {
    logContractFail(`error: ${e.message}`, JSON.stringify({ refType: typeof ref, ref: String(ref).slice(0, 64) }));
    return null; // a bad reference shouldn't kill the whole export
  }
}

async function main() {
  // Work on a temp copy so the real save is never touched.
  const tmp = path.join(os.tmpdir(), `madden-gm-${Date.now()}`);
  await fs.copyFile(SAVE_PATH, tmp);

  console.log(`Save: ${SAVE_PATH}`);
  console.log('Parsing save (this can take a minute)...');
  const franchise = await Franchise.create(tmp, { autoParse: true });
  console.log(`Detected game year: ${franchise.gameYear ?? 'unknown'}`);

  const [seasonRec] = await readTable(franchise, 'SeasonInfo', ['CurrentSeasonYear', 'CurrentWeek', 'CurrentWeekType', 'CurrentStage']);
  const teamRecs = await readTable(franchise, 'Team', TEAM_FIELDS);
  const playerRecs = await readTable(franchise, 'Player', PLAYER_FIELDS);

  // IsUserManaged is computed at runtime (not stored), so find the user's team
  // through the coach they control — or let MY_TEAM override it.
  let userTeamIndex = null;
  let userSource = null;
  const myTeamEnv = process.env.MY_TEAM?.toLowerCase();
  if (myTeamEnv) {
    const t = teamRecs.find((r) => r.ShortName?.toLowerCase() === myTeamEnv || `${r.LongName} ${r.DisplayName}`.toLowerCase().includes(myTeamEnv));
    if (t) { userTeamIndex = t.TeamIndex; userSource = 'MY_TEAM env var'; }
    else console.log(`  MY_TEAM="${process.env.MY_TEAM}" didn't match any team`);
  }
  if (userTeamIndex == null) {
    try {
      const coaches = await readTable(franchise, 'Coach', ['IsUserControlled', 'TeamIndex', 'FirstName', 'LastName']);
      const mine = coaches.filter((c) => c.IsUserControlled === true || c.IsUserControlled === 1);
      if (mine.length) {
        userTeamIndex = mine[0].TeamIndex;
        userSource = `user coach ${mine[0].FirstName} ${mine[0].LastName}`;
      }
      if (mine.length > 1) console.log(`  Note: ${mine.length} user-controlled coaches found, using the first`);
    } catch (e) {
      console.log(`  Coach lookup failed: ${e.message}`);
    }
  }


  let teams = teamRecs
    .filter((t) => t.ShortName || t.DisplayName || t.LongName)
    .map((t) => ({
      teamIndex: t.TeamIndex,
      name: `${t.LongName ?? ''} ${t.DisplayName ?? ''}`.trim() || t.ShortName,
      abbr: t.ShortName,
      isUser: t.TeamIndex === userTeamIndex,
      wins: (t.HomeWin ?? 0) + (t.RoadWin ?? 0),
      losses: (t.HomeLoss ?? 0) + (t.RoadLoss ?? 0),
      ties: (t.HomeTie ?? 0) + (t.RoadTie ?? 0),
      divRecord: `${t.DivisionWin ?? 0}-${t.DivisionLoss ?? 0}`,
      confRecord: `${t.ConfWin ?? 0}-${t.ConfLoss ?? 0}`,
      pointsFor: t.SeasonLeagPointsFor,
      pointsAgainst: t.SeasonLeagPointsAgainst,
      offRank: t.OffensiveRank,
      defRank: t.DefensiveRank,
      streak: t.SeasonWinLossStreak,
      cap: {
        roomRaw: unoffset(t.SalCapCapRoom),
        nextYearRoomRaw: unoffset(t.SalCapNextYearCapRoom),
        spendableRaw: unoffset(t.SalCapSpendingMoney),
        payrollRaw: t.SalCapRosterReserve,
        rosterSize: t.SalCapRosterSize,
        penaltiesThisYearRaw: t.ThisYearCapPenalties,
        penaltiesNextYearRaw: t.NextYearCapPenalties,
        creditsRaw: t.ThisYearCapCredits ?? 0,
        rolloverRaw: t.RolloverCap ?? 0
      }
    }));

  const contractCache = new Map();
  const players = [];
  for (const p of playerRecs) {
    const status = enumName(p.ContractStatus);
    if (['Retired', 'Deleted', 'None', 'Draft'].includes(status)) continue;
    const ratings = {};
    for (const f of RATING_FIELDS) ratings[f.replace('Rating', '')] = p[f];
    const injuryType = enumName(p.InjuryType);
    players.push({
      name: `${p.FirstName} ${p.LastName}`.trim(),
      pos: enumName(p.Position),
      age: p.Age,
      yearsPro: p.YearsPro,
      jersey: p.JerseyNum,
      teamIndex: p.TeamIndex,
      ovr: p.OverallRating,
      dev: DEV_MAP[enumName(p.TraitDevelopment)] ?? enumName(p.TraitDevelopment),
      contractStatus: status,
      capHitRaw: p.PLYR_CAPSALARY,
      contract: await resolveContract(franchise, p.Contract, contractCache),
      draft: { round: p.PLYR_DRAFTROUND, pick: p.PLYR_DRAFTPICK },
      injury: injuryType && !/^(None|Invalid)/i.test(injuryType)
        ? { type: injuryType, status: enumName(p.InjuryStatus), severity: enumName(p.InjurySeverity), onIR: !!p.IsInjuredReserve }
        : null,
      height: p.Height,
      weight: p.Weight != null ? p.Weight + 160 : null, // Madden stores weight as lbs - 160
      ratings
    });
  }

  // Keep only real teams: ones with 40+ signed players (drops FA pool / placeholder teams).
  const rosterCounts = new Map();
  for (const p of players) {
    if (['FreeAgent', 'Retired', 'Deleted', 'Draft', 'None'].includes(p.contractStatus)) continue;
    rosterCounts.set(p.teamIndex, (rosterCounts.get(p.teamIndex) ?? 0) + 1);
  }
  const dropped = teams.filter((t) => (rosterCounts.get(t.teamIndex) ?? 0) < 40);
  if (dropped.length) console.log(`  Dropped non-league teams: ${dropped.map((t) => `${t.name} (${rosterCounts.get(t.teamIndex) ?? 0})`).join(', ')}`);
  teams = teams.filter((t) => (rosterCounts.get(t.teamIndex) ?? 0) >= 40);

  const rooms = teams.map((t) => t.cap.roomRaw / 100).sort((x, y) => x - y);
  console.log(`  League cap room range: $${rooms[0].toFixed(1)}M to $${rooms.at(-1).toFixed(1)}M`);

  const snapshot = {
    exportedAt: new Date().toISOString(),
    gameYear: franchise.gameYear ?? null,
    season: {
      year: seasonRec?.CurrentSeasonYear,
      week: seasonRec?.CurrentWeek,
      weekType: enumName(seasonRec?.CurrentWeekType),
      stage: enumName(seasonRec?.CurrentStage)
    },
    teams,
    players
  };

  await fs.writeFile(OUT_FILE, JSON.stringify(snapshot));
  await fs.rm(tmp, { force: true });

  const user = teams.find((t) => t.isUser);
  if (!user) {
    console.log('Could not find a user team. First few team records as read:');
    for (const t of teamRecs.slice(0, 5)) {
      console.log('   ', t.TeamIndex, JSON.stringify(t.LongName), JSON.stringify(t.DisplayName), JSON.stringify(t.ShortName), 'user=' + t.IsUserManaged);
    }
  }
  const sample = players.filter((p) => user && p.teamIndex === user.teamIndex).sort((a, b) => b.ovr - a.ovr)[0];
  console.log(`Contracts: ${contractStats.resolved} resolved, ${contractStats.empty} free agents/no contract, ${contractStats.tried - contractStats.resolved - contractStats.empty} failed`);
  console.log(`Wrote ${OUT_FILE}: ${teams.length} teams, ${players.length} players`);
  console.log(user
    ? `Your team: ${user.name} (${user.wins}-${user.losses}) — found via ${userSource}`
    : 'Your team: not detected. Re-run with MY_TEAM set, e.g.  set MY_TEAM=CLE');
  if (user) {
    const c = user.cap;
    const m = (raw) => `$${(raw / 100).toFixed(1)}M`;
    console.log(`Cap: space ${m(c.roomRaw)} | salaries ${m(c.payrollRaw)} | dead ${m(c.penaltiesThisYearRaw)} | next year space ${m(c.nextYearRoomRaw)}`);
  }
  if (sample) console.log(`Sanity check — top player: ${sample.name}, ${sample.pos}, ${sample.ovr} OVR, cap hit raw=${sample.capHitRaw}`);

  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) await uploadToGitHub(JSON.stringify(snapshot));
  else console.log('No GITHUB_TOKEN/GITHUB_REPO set — skipped upload (local file only).');
}

async function uploadToGitHub(content) {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'data';
  const url = `https://api.github.com/repos/${repo}/contents/${SNAPSHOT_PATH_IN_REPO}`;
  const headers = {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'madden-gm-exporter'
  };
  const existing = await fetch(`${url}?ref=${branch}`, { headers });
  const sha = existing.ok ? (await existing.json()).sha : undefined;
  const res = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      message: `madden snapshot ${new Date().toISOString()}`,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha && { sha })
    })
  });
  if (!res.ok) throw new Error(`GitHub upload failed: ${res.status} ${await res.text()}`);
  console.log(`Uploaded to ${repo}@${branch}/${SNAPSHOT_PATH_IN_REPO}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
