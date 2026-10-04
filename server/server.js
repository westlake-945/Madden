// Madden GM MCP server — host on Render (or run locally).
// Reads the latest franchise snapshot from GitHub (or a local file) and
// exposes read-only GM tools to Claude over Streamable HTTP.
//
// Env: GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH (default "data")
//      or SNAPSHOT_FILE=./franchise.json for local testing
//      MCP_PATH (default "/mcp") — make it unguessable, like your Sleeper one
//      CAP_UNIT (default 10000) — Madden stores money in $10k units (verified against M27)

import express from 'express';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const PORT = process.env.PORT || 3000;
const MCP_PATH = process.env.MCP_PATH || '/mcp';
const CAP_UNIT = Number(process.env.CAP_UNIT || 10000); // Madden stores money in $10k units
const CACHE_MS = 60_000;

// ---------- snapshot loading ----------
let cache = { at: 0, data: null };

async function loadSnapshot() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  let text;
  if (process.env.SNAPSHOT_FILE) {
    text = await fs.readFile(process.env.SNAPSHOT_FILE, 'utf8');
  } else {
    const branch = process.env.GITHUB_BRANCH || 'data';
    const res = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/madden/franchise.json?ref=${branch}`,
      { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github.raw', 'User-Agent': 'madden-gm' } }
    );
    if (!res.ok) throw new Error(`Couldn't load snapshot from GitHub (${res.status}). Run the exporter first.`);
    text = await res.text();
  }
  cache = { at: Date.now(), data: JSON.parse(text) };
  return cache.data;
}

// ---------- helpers ----------
const money = (raw) => (raw == null ? null : raw * CAP_UNIT);
const teamMoney = money; // team cap values use the same unit as player cap hits
const record = (t) => `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ''}`;
const teamName = (snap, idx) => snap.teams.find((t) => t.teamIndex === idx)?.abbr ?? 'FA';
const userTeam = (snap) => {
  const t = snap.teams.find((x) => x.isUser);
  if (!t) throw new Error('No user-controlled team found in this snapshot.');
  return t;
};
const findTeam = (snap, q) => {
  if (!q) return userTeam(snap);
  const s = q.toLowerCase();
  const t = snap.teams.find((x) => x.abbr?.toLowerCase() === s || x.name.toLowerCase().includes(s));
  if (!t) throw new Error(`No team matches "${q}".`);
  return t;
};
const brief = (snap, p) => ({
  name: p.name, pos: p.pos, ovr: p.ovr, age: p.age, dev: p.dev, team: teamName(snap, p.teamIndex),
  status: p.contractStatus, yearsLeft: p.contract?.yearsLeft ?? null, capHit: money(p.capHitRaw), injury: p.injury?.type ?? null
});
const json = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }] });
const safe = (fn) => async (args) => {
  try { return json(await fn(await loadSnapshot(), args ?? {})); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: e.message }] }; }
};

// ---------- tools ----------
function buildServer() {
  const server = new McpServer({ name: 'madden-gm', version: '0.1.0' });

  server.registerTool('get_franchise_overview', {
    description: "Season/week, the user's team record, ranks, cap room, and when the snapshot was exported. Call this first.",
    inputSchema: {}
  }, safe((snap) => {
    const t = userTeam(snap);
    return {
      exportedAt: snap.exportedAt, season: snap.season,
      team: { name: t.name, record: record(t), div: t.divRecord, conf: t.confRecord, pointsFor: t.pointsFor, pointsAgainst: t.pointsAgainst, offRank: t.offRank, defRank: t.defRank, streak: t.streak },
      cap: { room: teamMoney(t.cap.roomRaw), spendable: teamMoney(t.cap.spendableRaw), nextYearRoom: teamMoney(t.cap.nextYearRoomRaw), playerSalaries: teamMoney(t.cap.payrollRaw), deadMoney: teamMoney(t.cap.penaltiesThisYearRaw), rosterSize: t.cap.rosterSize }
    };
  }));

  server.registerTool('get_roster', {
    description: "A team's roster sorted by position then OVR. Defaults to the user's team.",
    inputSchema: { team: z.string().optional().describe('Team abbr or name; omit for user team'), position: z.string().optional().describe('e.g. QB, WR, LEDGE, CB') }
  }, safe((snap, { team, position }) => {
    const t = findTeam(snap, team);
    return snap.players
      .filter((p) => p.teamIndex === t.teamIndex && (!position || p.pos?.toLowerCase() === position.toLowerCase()))
      .sort((a, b) => (a.pos > b.pos ? 1 : a.pos < b.pos ? -1 : b.ovr - a.ovr))
      .map((p) => brief(snap, p));
  }));

  server.registerTool('get_player', {
    description: 'Full detail on a player: every rating, contract by year, injury, draft info.',
    inputSchema: { name: z.string() }
  }, safe((snap, { name }) => {
    const s = name.toLowerCase();
    const hits = snap.players.filter((p) => p.name.toLowerCase().includes(s));
    if (!hits.length) throw new Error(`No player matches "${name}".`);
    return hits.slice(0, 5).map((p) => ({
      ...brief(snap, p), yearsPro: p.yearsPro, height: p.height, weight: p.weight, draft: p.draft,
      contractStatus: p.contractStatus,
      contract: p.contract && { ...p.contract, salaryByYear: p.contract.salaryByYear.map(money), bonusByYear: p.contract.bonusByYear.map(money) },
      injury: p.injury, ratings: p.ratings
    }));
  }));

  server.registerTool('get_cap_sheet', {
    description: "User team's contracts sorted by cap hit, plus expiring deals (players in their final season). yearsLeft counts the current season. Use for re-sign/cut/restructure decisions.",
    inputSchema: {}
  }, safe((snap) => {
    const t = userTeam(snap);
    const mine = snap.players.filter((p) => p.teamIndex === t.teamIndex);
    return {
      capRoom: teamMoney(t.cap.roomRaw), spendable: teamMoney(t.cap.spendableRaw), nextYearCapRoom: teamMoney(t.cap.nextYearRoomRaw),
      playerSalaries: teamMoney(t.cap.payrollRaw),
      deadMoney: { thisYear: teamMoney(t.cap.penaltiesThisYearRaw), nextYear: teamMoney(t.cap.penaltiesNextYearRaw) },
      contracts: mine.sort((a, b) => (b.capHitRaw ?? 0) - (a.capHitRaw ?? 0)).map((p) => brief(snap, p)),
      // yearsLeft includes the current season (verified in-game), so 1 = final year.
      expiring: mine.filter((p) => p.contractStatus === 'Expiring' || p.contract?.yearsLeft === 1).map((p) => brief(snap, p))
    };
  }));

  server.registerTool('get_injuries', {
    description: "Injured players on a team (defaults to user's team).",
    inputSchema: { team: z.string().optional() }
  }, safe((snap, { team }) => {
    const t = findTeam(snap, team);
    return snap.players.filter((p) => p.teamIndex === t.teamIndex && p.injury).map((p) => ({ ...brief(snap, p), injury: p.injury }));
  }));

  server.registerTool('get_standings', {
    description: 'League standings with records, points, and off/def ranks.',
    inputSchema: {}
  }, safe((snap) =>
    [...snap.teams]
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || (b.pointsFor - b.pointsAgainst) - (a.pointsFor - a.pointsAgainst))
      .map((t) => ({ team: t.name, abbr: t.abbr, record: record(t), pf: t.pointsFor, pa: t.pointsAgainst, offRank: t.offRank, defRank: t.defRank, you: t.isUser || undefined }))
  ));

  server.registerTool('search_players', {
    description: 'Find trade or free-agent targets league-wide by position, OVR, age, dev trait.',
    inputSchema: {
      position: z.string().optional(),
      minOvr: z.number().optional(),
      maxAge: z.number().optional(),
      dev: z.string().optional().describe('Normal, Star, Superstar, XFactor'),
      freeAgentsOnly: z.boolean().optional(),
      excludeMyTeam: z.boolean().optional().default(true),
      limit: z.number().optional().default(25)
    }
  }, safe((snap, a) => {
    const me = userTeam(snap).teamIndex;
    const validTeams = new Set(snap.teams.map((t) => t.teamIndex));
    // Signable = on a league team, or an actual free agent. Excludes hidden legends,
    // created placeholders, and Pro Bowl copies that sit on non-league teams.
    const signable = (p) => validTeams.has(p.teamIndex) || p.contractStatus === 'FreeAgent';
    return snap.players
      .filter((p) =>
        (!a.position || p.pos?.toLowerCase() === a.position.toLowerCase()) &&
        (a.minOvr == null || p.ovr >= a.minOvr) &&
        (a.maxAge == null || p.age <= a.maxAge) &&
        (!a.dev || p.dev?.toLowerCase().includes(a.dev.toLowerCase())) &&
        signable(p) &&
        (!a.freeAgentsOnly || p.contractStatus === 'FreeAgent') &&
        (!a.excludeMyTeam || p.teamIndex !== me))
      .sort((x, y) => y.ovr - x.ovr)
      .slice(0, a.limit)
      .map((p) => brief(snap, p));
  }));

  return server;
}

// ---------- HTTP (stateless Streamable HTTP, same shape as most remote MCPs) ----------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_req, res) => res.send('ok'));

app.post(MCP_PATH, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.all(MCP_PATH, (_req, res) => res.status(405).json({ error: 'Use POST' }));

app.listen(PORT, () => console.log(`madden-gm MCP listening on :${PORT}${MCP_PATH}`));
