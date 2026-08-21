import express from 'express';
import { fileURLToPath } from 'node:url';
import { parseTeams, parsePool, toCSV, sanitiseRules } from '../shared/domain.js';
import * as repo from './repo.js';
import { pool as pgPool } from './db.js';
import {
  authRequired, isSignedIn, checkPassword, setSessionCookie, clearSessionCookie, requireAdmin
} from './auth.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));

// Wraps an async handler so a rejected promise reaches the error handler.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------- health and session ---------- */

app.get('/api/health', h(async (_req, res) => {
  const { rows } = await pgPool.query('SELECT now() AS at');
  res.json({ ok: true, db: 'up', at: rows[0].at });
}));

app.get('/api/session', (req, res) => {
  res.json({ authRequired: authRequired(), signedIn: isSignedIn(req) });
});

app.post('/api/session', (req, res) => {
  if (!authRequired()) return res.json({ signedIn: true, authRequired: false });
  if (!checkPassword(req.body?.password)) {
    return res.status(401).json({ error: 'That passcode is not right.' });
  }
  setSessionCookie(res);
  res.json({ signedIn: true, authRequired: true });
});

app.delete('/api/session', (req, res) => {
  clearSessionCookie(res);
  res.json({ signedIn: false, authRequired: authRequired() });
});

/* ---------- reading ---------- */

app.get('/api/state', h(async (req, res) => {
  const state = await repo.readState();
  res.json({ ...state, session: { authRequired: authRequired(), signedIn: isSignedIn(req) } });
}));

app.get('/api/export.csv', h(async (_req, res) => {
  const state = await repo.readState();
  res.type('text/csv; charset=utf-8')
    .set('Content-Disposition', 'attachment; filename="SIH-2026-RBCET-teams.csv"')
    .send(toCSV(state, state.rules));
}));

/* ---------- writing ---------- */

app.post('/api/students', requireAdmin, h(async (req, res) => {
  res.status(201).json(await repo.addStudent(req.body || {}));
}));

app.patch('/api/students/:id', requireAdmin, h(async (req, res) => {
  res.json({ state: await repo.patchStudent(Number(req.params.id), req.body || {}) });
}));

app.post('/api/students/:id/move', requireAdmin, h(async (req, res) => {
  const { to, force } = req.body || {};
  res.json(await repo.moveStudent(Number(req.params.id), to, { force }));
}));

app.post('/api/students/:id/lead', requireAdmin, h(async (req, res) => {
  res.json(await repo.makeLeader(Number(req.params.id)));
}));

app.delete('/api/teams/:id', requireAdmin, h(async (req, res) => {
  res.json(await repo.dissolveTeam(Number(req.params.id)));
}));

app.post('/api/teams/autobuild', requireAdmin, h(async (req, res) => {
  res.json(await repo.buildTeams(req.body?.count));
}));

app.post('/api/teams/confirm', requireAdmin, h(async (_req, res) => {
  res.json(await repo.confirmDrafts());
}));

app.put('/api/rules', requireAdmin, h(async (req, res) => {
  res.json({ state: await repo.putRules(sanitiseRules(req.body)) });
}));

app.post('/api/import', requireAdmin, h(async (req, res) => {
  const teamsCsv = (req.body?.teamsCsv || '').trim();
  const poolCsv = (req.body?.poolCsv || '').trim();
  if (!teamsCsv && !poolCsv) return res.status(400).json({ error: 'Nothing pasted.' });

  // An empty box means "keep what is loaded", so null is passed through.
  const teams = teamsCsv ? parseTeams(teamsCsv) : null;
  const students = poolCsv ? parsePool(poolCsv) : null;
  if (teams && !teams.length) return res.status(400).json({ error: 'No teams could be read from that teams sheet.' });
  if (students && !students.length) return res.status(400).json({ error: 'No students could be read from that unassigned sheet.' });

  const state = await repo.replaceRegister({ teams, pool: students }, 'import');
  res.json({ state, message: 'Register replaced from the pasted sheets.' });
}));

app.post('/api/reset', requireAdmin, h(async (_req, res) => {
  const state = await repo.replaceRegister({ teams: [], pool: [] }, 'reset');
  res.json({ state, message: 'Register emptied. Import a sheet or add students to start again.' });
}));

app.get('/api/audit', h(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const { rows } = await pgPool.query('SELECT id, at, action, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT $1', [limit]);
  res.json({ entries: rows });
}));

/* ---------- static frontend ---------- */

// Nothing here is content-hashed, so a long max-age leaves a coordinator on a
// stale interface for an hour after a deploy. Revalidate every load instead:
// the ETag turns the repeat visit into a 304, which costs one round trip and
// is worth it for a register a handful of people share.
app.use('/shared', express.static(`${ROOT}shared`, { maxAge: 0, etag: true }));
app.use(express.static(`${ROOT}public`, { maxAge: 0, etag: true, extensions: ['html'] }));

app.use('/api', (_req, res) => res.status(404).json({ error: 'No such endpoint.' }));
app.use((_req, res) => res.sendFile(`${ROOT}public/index.html`));

/* ---------- errors ---------- */

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Something went wrong.' });
});

export default app;
