import 'dotenv/config';
import { ensureSchema, readState } from './repo.js';
import { validateTeam } from '../shared/domain.js';
import { pool } from './db.js';

// pnpm db:setup    create the schema if it is not there yet, then report what
// the register currently holds. It never writes register data: a new register
// starts empty and is filled from the interface.

await ensureSchema();
console.log('schema ready');

const s = await readState();
const flagged = s.teams.filter(t => validateTeam(t, s.rules).errors.length).length;
console.log(`${s.teams.length} teams, ${flagged} flagged, ${s.pool.length} students unassigned`);
await pool.end();
