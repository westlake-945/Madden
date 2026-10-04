// Dumps every SalaryInfo table/record, resolving array fields, so we can find the real cap.
import Franchise from 'madden-franchise';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), 'madden-capdiag');
await fs.copyFile(process.argv[2], tmp);
const f = await Franchise.create(tmp);

async function resolveArray(ref) {
  if (typeof ref !== 'string' || /^0+$/.test(ref)) return null;
  const table = f.getTableById(parseInt(ref.slice(0, 15), 2));
  if (!table) return `(no table)`;
  await table.readRecords();
  const rec = table.records[parseInt(ref.slice(15), 2)];
  return rec ? rec.fieldsArray.map((fld) => fld.value) : '(no record)';
}

for (const table of f.getAllTablesByName('SalaryInfo')) {
  await table.readRecords();
  const recs = table.records.filter((r) => !r.isEmpty);
  console.log(`SalaryInfo table id=${table.header?.tableId}, records=${recs.length}`);
  for (const r of recs) {
    for (const key of ['InitialSalaryCap', 'TeamSalaryCap', 'SalaryMultiplier', 'RosterReserveSalary', 'WeeklySharedRevenue']) {
      console.log(`  ${key}: ${r[key]}`);
    }
    console.log(`  SalaryCapIncreasePerYear: ${JSON.stringify(await resolveArray(r.SalaryCapIncreasePerYear))}`);
  }
}

const [season] = (await (async () => { const t = f.getTableByName('SeasonInfo'); await t.readRecords(); return t.records; })());
console.log(`SeasonInfo: CurrentYear=${season.CurrentYear} CurrentSeasonYear=${season.CurrentSeasonYear} BaseCalendarYear=${season.BaseCalendarYear}`);
await fs.rm(tmp, { force: true });
