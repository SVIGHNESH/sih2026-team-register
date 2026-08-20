import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { ensureSchema, replaceRegister, isEmpty, readState } from './repo.js';
import { parseTeams, parsePool, validateTeam } from '../shared/domain.js';
import { pool } from './db.js';

// pnpm db:setup            create the schema, seed only if empty
// pnpm db:setup --force    create the schema and reload the shipped sheets
const force = process.argv.includes('--force');

await ensureSchema();
console.log('schema ready');

if (force || await isEmpty()) {
  await replaceRegister({
    teams: parseTeams(await readFile(new URL('../data/teams.csv', import.meta.url), 'utf8')),
    pool: parsePool(await readFile(new URL('../data/pool.csv', import.meta.url), 'utf8'))
  }, force ? 'reset' : 'seed');
  console.log('seeded from data/teams.csv and data/pool.csv');
} else {
  console.log('register already holds data, left alone (use --force to reload)');
}

const s = await readState();
const flagged = s.teams.filter(t => validateTeam(t, s.rules).errors.length).length;
console.log(`${s.teams.length} teams, ${flagged} flagged, ${s.pool.length} students unassigned`);
await pool.end();
