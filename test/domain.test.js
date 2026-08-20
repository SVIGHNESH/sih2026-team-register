import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseTeams, parsePool, validateTeam, blockedReason, capacity,
  autoBuild, toCSV, DEFAULT_RULES, sanitiseRules, readName, normYear
} from '../shared/domain.js';

const teamsCsv = await readFile(new URL('../data/teams.csv', import.meta.url), 'utf8');
const poolCsv = await readFile(new URL('../data/pool.csv', import.meta.url), 'utf8');
const R = DEFAULT_RULES;
const withIds = list => list.map((p, i) => ({ ...p, id: i + 1 }));

test('the shipped teams sheet reads back as 18 teams', () => {
  const teams = parseTeams(teamsCsv);
  assert.equal(teams.length, 18);
  assert.equal(teams[0].no, '1');
  assert.equal(teams[0].people[0].name, 'Shourya');
  assert.equal(teams[0].people[0].role, 'Leader');
});

test('a ( W ) marker and a year hint are read off the name', () => {
  assert.deepEqual(readName('Ishu -( W )'), { name: 'Ishu', girl: true, hint: null });
  assert.deepEqual(readName('Vayu (4th Year)'), { name: 'Vayu', girl: false, hint: 4 });
  assert.deepEqual(readName('Deepanshi (4th) ( W )'), { name: 'Deepanshi', girl: true, hint: 4 });
  assert.equal(normYear('Final Year'), 4);
  assert.equal(normYear(''), null);
});

test('nine of the eighteen shipped teams break a rule', () => {
  const flagged = parseTeams(teamsCsv).filter(t => validateTeam(t, R).errors.length);
  assert.equal(flagged.length, 9);
  const byNo = Object.fromEntries(flagged.map(t => [t.no, validateTeam(t, R).errors.join(' ')]));
  assert.match(byNo['3'], /Rule 4/);   // three 3rd-years, no 4th-year
  assert.match(byNo['4'], /Rule 3/);   // no girl marked
  assert.match(byNo['14'], /Rule 2/);  // no first-year
  assert.match(byNo['2'], /Short by 1/);
});

test('the pool holds 31 students, 8 girls and 23 boys', () => {
  const pool = parsePool(poolCsv);
  assert.equal(pool.length, 31);
  assert.equal(pool.filter(p => p.girl).length, 8);
  assert.equal(pool.filter(p => !p.girl).length, 23);
});

test('boys are the binding constraint at four complete teams', () => {
  const cap = capacity(withIds(parsePool(poolCsv)), R);
  assert.equal(cap.max, 4);
  assert.match(cap.binding.why, /boys available \(23\)/);
});

test('relaxing rule 3 to at-least lifts the ceiling to five teams', () => {
  const cap = capacity(withIds(parsePool(poolCsv)), { ...R, girlMode: 'atleast' });
  assert.equal(cap.max, 5);   // now bound by headcount, 31 students over 6
});

test('a blocked destination explains itself', () => {
  const teams = parseTeams(teamsCsv);
  const t9 = teams.find(t => t.no === '9');          // one 4th-year, three 3rd-years
  assert.equal(blockedReason(t9, { girl: false, year: 3 }, R), 'full at 6');
  const t2 = teams.find(t => t.no === '2');          // five members, one girl
  assert.equal(blockedReason(t2, { girl: true, year: 1 }, R), 'already has 1 girl');
  assert.equal(blockedReason(t2, { girl: false, year: 1 }, R), null);
});

test('auto-build produces four teams that all clear the rules', () => {
  const res = autoBuild(withIds(parsePool(poolCsv)), R, 4);
  assert.equal(res.teams.length, 4);
  for (const t of res.teams) {
    assert.deepEqual(validateTeam(t, R).errors, [], `team ${t.no} should be clear`);
    assert.equal(t.people[0].role, 'Leader');
  }
  assert.equal(res.left.length, 7);   // 31 in the pool, 24 placed
});

test('auto-build is reproducible for the same inputs', () => {
  const a = autoBuild(withIds(parsePool(poolCsv)), R, 4);
  const b = autoBuild(withIds(parsePool(poolCsv)), R, 4);
  assert.deepEqual(a.teams.map(t => t.people.map(p => p.id)), b.teams.map(t => t.people.map(p => p.id)));
});

test('export and re-import keeps every girl marker and year', () => {
  const before = { teams: parseTeams(teamsCsv), pool: parsePool(poolCsv) };
  const csv = toCSV(before, R);
  const after = { teams: parseTeams(csv), pool: parsePool(csv) };

  assert.equal(after.teams.length, before.teams.length);
  assert.equal(after.pool.length, before.pool.length);
  const flat = s => s.teams.flatMap(t => t.people.map(p => `${t.no}/${p.name}/${p.year}/${p.girl}/${p.role}`));
  assert.deepEqual(flat(after), flat(before));
  const flatPool = s => s.pool.map(p => `${p.name}/${p.year}/${p.girl}`);
  assert.deepEqual(flatPool(after), flatPool(before));
});

test('rules coming off the wire are clamped to something sane', () => {
  const R2 = sanitiseRules({ sizeMin: 8, sizeMax: 2, y4max: -5, girlMode: 'whatever', girlN: '3' });
  assert.equal(R2.sizeMin, 8);
  assert.equal(R2.sizeMax, 8);       // raised to meet the minimum
  assert.equal(R2.y4max, 0);
  assert.equal(R2.girlMode, 'exactly');
  assert.equal(R2.girlN, 3);
  assert.deepEqual(sanitiseRules(null), DEFAULT_RULES);
});
