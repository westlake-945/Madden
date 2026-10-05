# madden-gm

Read-only Madden 27 (PC) franchise connector, so Claude can act as your GM and coaching assistant.

```
Madden save ──export.bat──▶ GitHub (data branch) ──▶ Render MCP server ──▶ Claude
```

The exporter parses a **temp copy** of your save, so your real franchise is never written to.

## Repo layout
| Path | What it is |
| --- | --- |
| `exporter/export.js` | Runs on your PC. Save → `franchise.json` → uploads to the `data` branch |
| `export.bat` | Double-click to run the exporter (auto-picks your newest `CAREER-` save) |
| `server/server.js` | MCP server Render runs. Reads the snapshot from GitHub |
| `render.yaml` | Render Blueprint (one-click service setup) |
| `.env.example` | Every env var, PC and server |
| `tools/` | Diagnostic scripts used to verify the save format |

## One-time setup

### 1. Create the repo and push
Make a **private** GitHub repo named `madden-gm`, then from this folder:
```
git init
git add .
git commit -m "madden-gm v0.1"
git branch -M main
git remote add origin https://github.com/<you>/madden-gm.git
git push -u origin main
git branch data
git push origin data
```
Snapshots go to `data` so Render doesn't redeploy every time you export.

### 2. PC upload token
GitHub → Settings → Developer settings → Fine-grained tokens → limit it to `madden-gm` with **Contents: Read and write**.
```
setx GITHUB_TOKEN "<token>"
setx GITHUB_REPO "<you>/madden-gm"
```
Open a **new** terminal (setx only applies to new ones), run `npm install`, then double-click `export.bat`.
The last line should be `Uploaded to <you>/madden-gm@data/madden/franchise.json`.

### 3. Render
New → **Blueprint** → pick `madden-gm`. When prompted, set:
- `GITHUB_TOKEN`: a token with Contents: Read on the repo
- `GITHUB_REPO`: `<you>/madden-gm`
- `MCP_PATH`: `/mcp-<guid>` (PowerShell: `[guid]::NewGuid()`). This path is the only auth, so keep it secret.

Check that `https://<app>.onrender.com/health` returns `ok`.

### 4. Claude
Settings → Connectors → Add custom connector → `https://<app>.onrender.com/mcp-<guid>`

## Weekly loop
Advance the week in Madden → back out to the menu (so the autosave writes) → double-click `export.bat` → ask Claude.

## Tools Claude gets
| Tool | Use |
| --- | --- |
| `get_franchise_overview` | Season/week, record, ranks, cap space (call first) |
| `get_roster` | Any team's roster, filter by position |
| `get_player` | All ratings, contract by year, injury, draft info |
| `get_cap_sheet` | Cap hits, expiring deals, dead money, next-year space |
| `get_injuries` | Injury report for any team |
| `get_standings` | League table |
| `search_players` | Trade and free-agent targets by position, OVR, age, dev |
| `get_draft_class` | Prospects with public info (projection, college, size, combine/pro day). True ratings only with `showTrueRatings` |
| `get_draft_prospect` | One prospect in detail, same fog-of-war rule |
| `get_my_draft_picks` | Your picks, including ones acquired from other teams |

## Save-format notes (verified against a Madden 27 save)
- Money is stored in **$10k units** (`CAP_UNIT=10000`).
- Team cap-room fields (`SalCapCapRoom`, `SalCapNextYearCapRoom`, `SalCapSpendingMoney`) carry a **+160000 offset**.
- `SalCapRosterReserve` = Players' Salaries on the Team Salary screen.
- Weight is stored as **lbs − 160**.
- `TraitDevelopment` reuses CFB names: `College_Impact`=Star, `College_Star`=Superstar, `College_Elite`=X-Factor.
- `Team.IsUserManaged` isn't stored; the user team comes from the `Coach` with `IsUserControlled`. Override with `MY_TEAM=CLE`.
- Contract refs are 32-bit strings: first 15 bits are the table id, the rest is the row (`PlayerContract`).

## Ideas for v0.3
Depth chart, schedule/results (`SeasonGame`), season stats.
