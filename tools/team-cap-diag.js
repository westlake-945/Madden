// Scans the Browns' Team record (all fields) for values matching the in-game cap screen.
// Usage: node exporter/team-cap-diag.js "<save path>" [TEAM_ABBR]
import Franchise from 'madden-franchise';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const abbr = (process.argv[3] || 'CLE').toUpperCase();
// On-screen values in raw units ($10k): name -> [low, high] to allow rounding
const TARGETS = {
  'Cap Space $26.5M': [2645, 2655],
  'Player Salaries $256M': [25550, 25650],
  'Reserve $14.3M': [1425, 1435],
  'Dead Cap $99.8M': [9975, 9985],
  'Total cap ~$396.6M': [39550, 39670],
  'Total cap minus credits/rollover': [36000, 36200],
  'Incentive Credits $1M': [100, 100]
};
const match = (v) => Object.entries(TARGETS).filter(([, [lo, hi]]) => v >= lo && v <= hi).map(([k]) => k);

const tmp = path.join(os.tmpdir(), 'madden-teamcapdiag');
await fs.copyFile(process.argv[2], tmp);
const f = await Franchise.create(tmp);

for (const table of f.getAllTablesByName('Team')) {
  await table.readRecords();
  const rec = table.records.find((r) => !r.isEmpty && String(r.ShortName).toUpperCase() === abbr);
  if (!rec) continue;
  console.log(`== ${abbr} record (table id=${table.header?.tableId}) ==`);
  const hits = [];
  for (const fld of rec.fieldsArray) {
    const v = fld.value;
    if (typeof v !== 'number') continue;
    const m = match(v);
    const name = fld.key ?? fld.name;
    if (m.length) hits.push(`  *** ${name} = ${v}  <-- ${m.join(', ')}`);
    else if (/cap|sal|reserve|budget|spend|credit|rollover|dead|penalt|payroll/i.test(name)) console.log(`      ${name} = ${v}`);
  }
  console.log(hits.length ? `\nMatches:\n${hits.join('\n')}` : '\nNo direct matches on the Team record.');
}

// Also scan SalaryInfo + any table with "Salary"/"Cap" in its name for the total-cap number.
for (const table of f.tables) {
  if (!/salary|cap/i.test(table.name ?? '') || /Formula|Eval|Tuning|Enum/i.test(table.name)) continue;
  try {
    await table.readRecords();
    for (const [i, rec] of table.records.entries()) {
      if (rec.isEmpty) continue;
      for (const fld of rec.fieldsArray) {
        const m = typeof fld.value === 'number' ? match(fld.value) : [];
        if (m.length) console.log(`  *** ${table.name}[${i}].${fld.key ?? fld.name} = ${fld.value}  <-- ${m.join(', ')}`);
      }
    }
  } catch { /* some tables can't be read without schemas; skip */ }
}
await fs.rm(tmp, { force: true });
