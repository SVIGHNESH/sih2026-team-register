/* End-to-end over the real HTTP surface and a real database.
   Skipped when DATABASE_URL is unset, so `pnpm test` still runs anywhere.
   It resets the register, so point it at a scratch database. */
import 'dotenv/config';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const live = Boolean(process.env.DATABASE_URL);
let server, base, app, pool, cookie = '';

before(async () => {
  if (!live) return;
  ({ app } = await import('../src/app.js'));
  ({ pool } = await import('../src/db.js'));
  const { ensureSchema } = await import('../src/repo.js');
  await ensureSchema();
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // The suite has to pass whether or not this deployment sets a passcode, so
  // sign in first when one is configured and carry the session from there.
  const { data: session } = await call('GET', '/api/session');
  if (session.authRequired) {
    const res = await fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD })
    });
    assert.ok(res.ok, 'ADMIN_PASSWORD is set but the test could not sign in with it');
    cookie = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    assert.ok(cookie, 'sign-in returned no session cookie');
  }

  await call('POST', '/api/reset');
});

after(async () => {
  if (!live) return;
  await new Promise(r => server.close(r));
  await pool.end();
});

async function call(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, data };
}

const opts = { skip: live ? false : 'DATABASE_URL is not set' };
const find = (state, name) =>
  state.teams.flatMap(t => t.people.map(p => ({ ...p, team: t }))).find(p => p.name === name)
  || state.pool.find(p => p.name === name);

test('the register comes back with the shipped sheets', opts, async () => {
  const { status, data } = await call('GET', '/api/state');
  assert.equal(status, 200);
  assert.equal(data.teams.length, 18);
  assert.equal(data.pool.length, 31);
  assert.equal(data.rules.sizeMin, 6);
  assert.equal(data.teams[0].people[0].role, 'Leader');
});

test('a year set on one student survives a reload', opts, async () => {
  const { data: before } = await call('GET', '/api/state');
  const shourya = find(before, 'Shourya');
  assert.equal(shourya.year, null);

  const { status } = await call('PATCH', `/api/students/${shourya.id}`, { year: 4 });
  assert.equal(status, 200);

  const { data: after } = await call('GET', '/api/state');
  assert.equal(find(after, 'Shourya').year, 4);
  await call('PATCH', `/api/students/${shourya.id}`, { year: null });
});

test('the server refuses a move that would break a rule', opts, async () => {
  const { data: state } = await call('GET', '/api/state');
  const t2 = state.teams.find(t => t.no === '2');          // five members, already one girl
  const girl = state.pool.find(p => p.girl);

  const bad = await call('POST', `/api/students/${girl.id}/move`, { to: t2.id });
  assert.equal(bad.status, 409);
  assert.match(bad.data.error, /already has 1 girl/);

  const boy = state.pool.find(p => !p.girl && p.year === 2);
  const good = await call('POST', `/api/students/${boy.id}/move`, { to: t2.id });
  assert.equal(good.status, 200);
  assert.equal(good.data.state.teams.find(t => t.no === '2').people.length, 6);
  assert.equal(good.data.state.pool.length, 30);

  await call('POST', `/api/students/${boy.id}/move`, { to: 'pool' });
});

test('seats close up when the leader leaves, and the next member leads', opts, async () => {
  const { data: state } = await call('GET', '/api/state');
  const t1 = state.teams.find(t => t.no === '1');
  const leader = t1.people[0], second = t1.people[1];

  await call('POST', `/api/students/${leader.id}/move`, { to: 'pool' });
  const { data: mid } = await call('GET', '/api/state');
  const t1b = mid.teams.find(t => t.no === '1');
  assert.equal(t1b.people.length, 5);
  assert.equal(t1b.people[0].id, second.id);
  assert.equal(t1b.people[0].role, 'Leader');

  // Put the old leader back and restore the seating.
  await call('POST', `/api/students/${leader.id}/move`, { to: t1.id });
  await call('POST', `/api/students/${leader.id}/lead`);
  const { data: end } = await call('GET', '/api/state');
  const t1c = end.teams.find(t => t.no === '1');
  assert.deepEqual(t1c.people.map(p => p.id), t1.people.map(p => p.id));
  assert.equal(t1c.people[0].role, 'Leader');
});

test('a student can be added straight into the pool', opts, async () => {
  const { data: before } = await call('GET', '/api/state');

  const { status, data } = await call('POST', '/api/students',
    { name: 'Late Walkin', year: 2, girl: true, branch: 'ECE' });
  assert.equal(status, 201);
  assert.match(data.message, /added to the unassigned pool/);
  assert.equal(data.state.pool.length, before.pool.length + 1);

  const added = data.state.pool.find(p => p.id === data.id);
  assert.ok(added, 'the new student should be in the pool');
  assert.equal(added.name, 'Late Walkin');
  assert.equal(added.year, 2);
  assert.equal(added.girl, true);
  assert.equal(added.branch, 'ECE');
  // Added to the pool, never onto a team.
  assert.equal(data.state.teams.some(t => t.people.some(p => p.id === data.id)), false);

  // A year is optional; a name is not.
  const bare = await call('POST', '/api/students', { name: 'No Year Known' });
  assert.equal(bare.status, 201);
  assert.equal(bare.data.state.pool.find(p => p.id === bare.data.id).year, null);

  assert.equal((await call('POST', '/api/students', { name: '   ' })).status, 409);
  assert.equal((await call('POST', '/api/students', { name: 'Bad Year', year: 7 })).status, 409);

  // The refusals added nobody.
  const { data: after } = await call('GET', '/api/state');
  assert.equal(after.pool.length, before.pool.length + 2);

  await call('POST', '/api/reset');
});

test('a student can be deleted outright from the pool', opts, async () => {
  const { data: before } = await call('GET', '/api/state');
  const victim = before.pool.find(p => p.name === 'Krishna Pal');
  assert.ok(victim, 'Krishna Pal should be in the shipped pool');

  const { status, data } = await call('POST', `/api/students/${victim.id}/move`, { to: 'delete' });
  assert.equal(status, 200);
  assert.match(data.message, /deleted from the register/);
  assert.equal(data.state.pool.length, before.pool.length - 1);
  assert.equal(data.state.pool.some(p => p.id === victim.id), false);

  // Gone for good, not just hidden, and gone for the next reader too.
  const { data: after } = await call('GET', '/api/state');
  assert.equal(after.pool.some(p => p.name === 'Krishna Pal'), false);
  assert.equal((await call('POST', `/api/students/${victim.id}/move`, { to: 'delete' })).status, 404);

  await call('POST', '/api/reset');
});

test('changing a rule re-flags the register', opts, async () => {
  const { data } = await call('PUT', '/api/rules', { girlMode: 'atleast', girlN: 1 });
  // Teams 4 and 13 have no girl, so they stay flagged either way; the teams
  // that had exactly one girl are unaffected. What must change is the mode.
  assert.equal(data.state.rules.girlMode, 'atleast');
  const reverted = await call('PUT', '/api/rules', { girlMode: 'exactly', girlN: 1 });
  assert.equal(reverted.data.state.rules.girlMode, 'exactly');
});

test('auto-build writes proposals, and confirming numbers them on', opts, async () => {
  const built = await call('POST', '/api/teams/autobuild', { count: 4 });
  assert.equal(built.status, 200);
  const drafts = built.data.state.teams.filter(t => t.draft);
  assert.equal(drafts.length, 4);
  assert.deepEqual(drafts.map(t => t.no), ['N1', 'N2', 'N3', 'N4']);
  assert.equal(built.data.state.pool.length, 7);

  // Rebuilding replaces the proposals rather than stacking a second set.
  const again = await call('POST', '/api/teams/autobuild', { count: 3 });
  assert.equal(again.data.state.teams.filter(t => t.draft).length, 3);

  const confirmed = await call('POST', '/api/teams/confirm');
  assert.equal(confirmed.data.state.teams.filter(t => t.draft).length, 0);
  assert.equal(confirmed.data.state.teams.length, 21);
  assert.deepEqual(confirmed.data.state.teams.slice(18).map(t => t.no), ['19', '20', '21']);
});

test('export writes a CSV the register can read back', opts, async () => {
  const res = await fetch(base + '/api/export.csv', { headers: cookie ? { Cookie: cookie } : {} });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const csv = await res.text();
  assert.match(csv, /^S\.No,Team Leader,Team Member,Year,Girl,Status/);

  const { data: before } = await call('GET', '/api/state');
  const imported = await call('POST', '/api/import', { teamsCsv: csv, poolCsv: csv });
  assert.equal(imported.status, 200);
  const after = imported.data.state;
  assert.equal(after.teams.length, before.teams.length);
  assert.equal(after.pool.length, before.pool.length);
  assert.deepEqual(
    after.teams.flatMap(t => t.people.map(p => `${t.no}/${p.name}/${p.year}/${p.girl}`)),
    before.teams.flatMap(t => t.people.map(p => `${t.no}/${p.name}/${p.year}/${p.girl}`))
  );
});

test('reset puts the shipped sheets back', opts, async () => {
  const { data } = await call('POST', '/api/reset');
  assert.equal(data.state.teams.length, 18);
  assert.equal(data.state.pool.length, 31);
});

test('the passcode gate matches how this deployment is configured', opts, async () => {
  const { data: session } = await call('GET', '/api/session');
  const bare = (path, init = {}) => fetch(base + path, init).then(r => r.status);

  // Reading is open either way.
  assert.equal(await bare('/api/state'), 200);

  if (session.authRequired) {
    // No cookie means no writing, whatever the browser thinks.
    assert.equal(await bare('/api/reset', { method: 'POST' }), 401);
    assert.equal(await bare('/api/teams/1', { method: 'DELETE' }), 401);
    // A wrong passcode gets nowhere.
    assert.equal(await bare('/api/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-passcode' })
    }), 401);
  } else {
    assert.equal(await bare('/api/state'), 200);
  }
});

test('a bad request is refused rather than half-applied', opts, async () => {
  assert.equal((await call('POST', '/api/import', { teamsCsv: '', poolCsv: '' })).status, 400);
  assert.equal((await call('DELETE', '/api/teams/999999')).status, 404);
  assert.equal((await call('PATCH', '/api/students/999999', { year: 2 })).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
  // Nothing above touched the register.
  const { data } = await call('GET', '/api/state');
  assert.equal(data.teams.length, 18);
});
