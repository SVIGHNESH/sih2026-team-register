import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { query, tx } from './db.js';
import {
  DEFAULT_RULES, sanitiseRules, blockedReason, autoBuild, validateTeam
} from '../shared/domain.js';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

// One writer at a time. Every mutation takes the same advisory lock, so two
// coordinators clicking at once queue rather than interleave and corrupt seats.
const REGISTER_LOCK = 20260101;
const lock = c => c.query('SELECT pg_advisory_xact_lock($1)', [REGISTER_LOCK]);

export class Conflict extends Error {
  constructor(message) { super(message); this.status = 409; }
}
export class NotFound extends Error {
  constructor(message) { super(message); this.status = 404; }
}

export async function ensureSchema() {
  await query(await readFile(SCHEMA_PATH, 'utf8'));
  await query(
    `INSERT INTO rules (id, data) VALUES (TRUE, $1) ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(DEFAULT_RULES)]
  );
}

async function audit(c, action, detail = {}) {
  await c.query('INSERT INTO audit_log (action, detail) VALUES ($1, $2)', [action, JSON.stringify(detail)]);
}

/* ---------- reading ---------- */

export async function readRules(c = { query }) {
  const { rows } = await c.query('SELECT data FROM rules WHERE id = TRUE');
  return sanitiseRules(rows[0]?.data);
}

// The whole register in one shape, matching what the browser renders.
export async function readState(c = { query }) {
  // Sequential on purpose: c may be a transaction client, and one client
  // cannot have two queries in flight at once.
  const teamRows = await c.query('SELECT id, no, draft FROM teams ORDER BY sort_key, id');
  const studentRows = await c.query(`SELECT id, name, year, girl, branch, team_id, seat
                                       FROM students ORDER BY team_id NULLS LAST, seat, id`);
  const rules = await readRules(c);

  const byTeam = new Map(teamRows.rows.map(t => [t.id, { ...t, people: [] }]));
  const poolStudents = [];
  for (const s of studentRows.rows) {
    const person = {
      id: s.id, name: s.name, year: s.year, girl: s.girl, branch: s.branch,
      role: s.seat === 0 ? 'Leader' : 'Member'
    };
    if (s.team_id != null && byTeam.has(s.team_id)) byTeam.get(s.team_id).people.push(person);
    else poolStudents.push(person);
  }
  return { teams: [...byTeam.values()], pool: poolStudents, rules };
}

/* ---------- helpers used inside a write transaction ---------- */

async function loadTeam(c, teamId) {
  const { rows } = await c.query('SELECT id, no, draft FROM teams WHERE id = $1', [teamId]);
  if (!rows[0]) throw new NotFound(`Team ${teamId} is not on the register.`);
  const people = await c.query(
    `SELECT id, name, year, girl, branch, seat FROM students WHERE team_id = $1 ORDER BY seat`, [teamId]
  );
  return { ...rows[0], people: people.rows };
}

async function loadStudent(c, studentId) {
  const { rows } = await c.query(
    'SELECT id, name, year, girl, branch, team_id, seat FROM students WHERE id = $1', [studentId]
  );
  if (!rows[0]) throw new NotFound(`Student ${studentId} is not on the register.`);
  return rows[0];
}

// Closes the gap left by a departure so seats stay 0..n-1 and seat 0 is always
// the leader. Called after every removal.
async function resealSeats(c, teamId) {
  if (teamId == null) return;
  await c.query(
    `UPDATE students s SET seat = r.rn - 1
       FROM (SELECT id, row_number() OVER (ORDER BY seat, id) AS rn
               FROM students WHERE team_id = $1) r
      WHERE s.id = r.id AND s.seat IS DISTINCT FROM r.rn - 1`,
    [teamId]
  );
}

async function nextSeat(c, teamId) {
  const { rows } = await c.query('SELECT COALESCE(MAX(seat) + 1, 0) AS n FROM students WHERE team_id = $1', [teamId]);
  return Number(rows[0].n);
}

/* ---------- mutations ---------- */

// Year and the girl marker. Deliberately unvalidated against the rules: the
// register should record the truth and flag the team, not refuse a correction.
export async function patchStudent(studentId, patch) {
  return tx(async c => {
    await lock(c);
    const before = await loadStudent(c, studentId);
    const sets = [], vals = [];
    if ('year' in patch) {
      const y = patch.year === null || patch.year === 0 ? null : Number(patch.year);
      if (y !== null && ![1, 2, 3, 4].includes(y)) throw new Conflict('Year must be 1, 2, 3, 4 or null.');
      sets.push(`year = $${sets.length + 1}`); vals.push(y);
    }
    if ('girl' in patch) { sets.push(`girl = $${sets.length + 1}`); vals.push(Boolean(patch.girl)); }
    if ('name' in patch) {
      const n = String(patch.name || '').trim();
      if (!n) throw new Conflict('A name cannot be empty.');
      sets.push(`name = $${sets.length + 1}`); vals.push(n);
    }
    if (!sets.length) throw new Conflict('Nothing to change.');
    vals.push(studentId);
    await c.query(`UPDATE students SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    await audit(c, 'student.patch', { studentId, name: before.name, patch });
    return readState(c);
  });
}

// to: a team id, 'pool', or 'delete'. Rules are re-checked here rather than
// trusted from the browser, so a stale tab cannot push a team over a rule.
export async function moveStudent(studentId, to, { force = false } = {}) {
  return tx(async c => {
    await lock(c);
    const s = await loadStudent(c, studentId);
    const from = s.team_id;
    let where;

    if (to === 'delete') {
      await c.query('DELETE FROM students WHERE id = $1', [studentId]);
      where = 'deleted from the register';
    } else if (to === 'pool') {
      if (from == null) throw new Conflict(`${s.name} is already in the unassigned pool.`);
      await c.query('UPDATE students SET team_id = NULL, seat = NULL WHERE id = $1', [studentId]);
      where = 'the unassigned pool';
    } else {
      const teamId = Number(to);
      if (!Number.isInteger(teamId)) throw new Conflict('Unknown destination.');
      if (teamId === from) throw new Conflict(`${s.name} is already on that team.`);
      const team = await loadTeam(c, teamId);
      const R = await readRules(c);
      const why = blockedReason(team, s, R);
      if (why && !force) throw new Conflict(`Team ${team.no} cannot take ${s.name}: ${why}.`);
      await c.query('UPDATE students SET team_id = $1, seat = $2 WHERE id = $3',
        [teamId, await nextSeat(c, teamId), studentId]);
      where = `Team ${team.no}`;
    }

    await resealSeats(c, from);
    await audit(c, 'student.move', { studentId, name: s.name, from, to, forced: Boolean(force) });
    return { state: await readState(c), message: `${s.name} ${to === 'delete' ? '' : 'moved to '}${where}.` };
  });
}

export async function makeLeader(studentId) {
  return tx(async c => {
    await lock(c);
    const s = await loadStudent(c, studentId);
    if (s.team_id == null) throw new Conflict(`${s.name} is not on a team.`);
    // Push everyone down one seat, then seat this student at the top.
    await c.query('UPDATE students SET seat = seat + 1 WHERE team_id = $1', [s.team_id]);
    await c.query('UPDATE students SET seat = 0 WHERE id = $1', [studentId]);
    await resealSeats(c, s.team_id);
    const team = await loadTeam(c, s.team_id);
    await audit(c, 'team.leader', { studentId, name: s.name, teamId: s.team_id });
    return { state: await readState(c), message: `${s.name} is now the leader of Team ${team.no}.` };
  });
}

export async function dissolveTeam(teamId) {
  return tx(async c => {
    await lock(c);
    const team = await loadTeam(c, teamId);
    await c.query('UPDATE students SET team_id = NULL, seat = NULL WHERE team_id = $1', [teamId]);
    await c.query('DELETE FROM teams WHERE id = $1', [teamId]);
    await audit(c, 'team.dissolve', { teamId, no: team.no, released: team.people.map(p => p.name) });
    return { state: await readState(c), message: `Team ${team.no} dissolved.` };
  });
}

export async function putRules(input) {
  return tx(async c => {
    await lock(c);
    const R = sanitiseRules(input);
    await c.query('UPDATE rules SET data = $1, updated_at = now() WHERE id = TRUE', [JSON.stringify(R)]);
    await audit(c, 'rules.update', R);
    return readState(c);
  });
}

// Proposals replace any previous proposals and leave confirmed teams alone.
export async function buildTeams(count) {
  return tx(async c => {
    await lock(c);
    const R = await readRules(c);
    const state = await readState(c);
    if (!state.pool.length) throw new Conflict('The unassigned pool is empty.');

    // Existing drafts go back into the pool before rebuilding.
    const drafts = state.teams.filter(t => t.draft);
    for (const t of drafts) {
      await c.query('UPDATE students SET team_id = NULL, seat = NULL WHERE team_id = $1', [t.id]);
      await c.query('DELETE FROM teams WHERE id = $1', [t.id]);
    }
    const poolNow = state.pool.concat(...drafts.map(t => t.people));

    const res = autoBuild(poolNow, R, Math.max(1, Number(count) || 1));
    const { rows: [{ next }] } = await c.query('SELECT COALESCE(MAX(sort_key), 0) + 1 AS next FROM teams');

    for (const [i, t] of res.teams.entries()) {
      const { rows: [row] } = await c.query(
        'INSERT INTO teams (no, draft, sort_key) VALUES ($1, TRUE, $2) RETURNING id',
        [t.no, Number(next) + i]
      );
      for (const [seat, p] of t.people.entries()) {
        await c.query('UPDATE students SET team_id = $1, seat = $2 WHERE id = $3', [row.id, seat, p.id]);
      }
    }
    const good = res.teams.filter(t => validateTeam(t, R).errors.length === 0).length;
    await audit(c, 'teams.autobuild', { requested: count, built: res.teams.length, clear: good, left: res.left.length });
    return {
      state: await readState(c),
      message: `${res.teams.length} teams proposed, ${good} clear of all rules, ${res.left.length} students still unplaced.`
    };
  });
}

// Drafts become part of the register and lose their N-numbers.
export async function confirmDrafts() {
  return tx(async c => {
    await lock(c);
    const { rows } = await c.query('SELECT id, no FROM teams WHERE draft ORDER BY sort_key, id');
    if (!rows.length) throw new Conflict('There are no proposed teams to confirm.');
    const { rows: [{ top }] } = await c.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(no, '\\D', '', 'g'), '')::INT), 0) AS top
         FROM teams WHERE NOT draft`
    );
    for (const [i, t] of rows.entries()) {
      await c.query('UPDATE teams SET draft = FALSE, no = $1 WHERE id = $2', [String(Number(top) + i + 1), t.id]);
    }
    await audit(c, 'teams.confirm', { count: rows.length });
    return { state: await readState(c), message: `${rows.length} proposed team${rows.length === 1 ? '' : 's'} confirmed onto the register.` };
  });
}

/* ---------- bulk replacement: import and reset ---------- */

// Wipes the register and writes the two sheets in. Everything happens in one
// transaction, so a malformed paste leaves the existing register untouched.
export async function replaceRegister({ teams, pool: poolStudents }, action = 'import') {
  return tx(async c => {
    await lock(c);
    const keepTeams = teams != null;
    const keepPool = poolStudents != null;

    if (keepTeams) {
      await c.query('DELETE FROM students WHERE team_id IS NOT NULL');
      await c.query('DELETE FROM teams');
    }
    if (keepPool) {
      await c.query('DELETE FROM students WHERE team_id IS NULL');
    }

    if (keepTeams) {
      for (const [i, t] of teams.entries()) {
        const { rows: [row] } = await c.query(
          'INSERT INTO teams (no, draft, sort_key) VALUES ($1, $2, $3) RETURNING id',
          [t.no, Boolean(t.draft), i + 1]
        );
        for (const [seat, p] of t.people.entries()) {
          await c.query(
            'INSERT INTO students (name, year, girl, branch, team_id, seat) VALUES ($1, $2, $3, $4, $5, $6)',
            [p.name, p.year, p.girl, p.branch || '', row.id, seat]
          );
        }
      }
    }
    if (keepPool) {
      for (const p of poolStudents) {
        await c.query(
          'INSERT INTO students (name, year, girl, branch) VALUES ($1, $2, $3, $4)',
          [p.name, p.year, p.girl, p.branch || '']
        );
      }
    }
    await audit(c, action, {
      teams: keepTeams ? teams.length : 'unchanged',
      pool: keepPool ? poolStudents.length : 'unchanged'
    });
    return readState(c);
  });
}

export async function isEmpty() {
  const { rows } = await query('SELECT (SELECT COUNT(*) FROM students) + (SELECT COUNT(*) FROM teams) AS n');
  return Number(rows[0].n) === 0;
}
