/* ============================================================
   SIH 2026 RBCET - Team Register
   Rules engine, CSV parsing, capacity analysis and auto-builder.

   Pure functions with no I/O and no DOM. The same module is imported
   by the Express server and served to the browser, so a rule is
   enforced on the server and explained in the UI from one definition.
   ============================================================ */

export const YEAR_LABEL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };

/* ---------- parsing ---------- */

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

// "Ishu -( W )" -> {name:'Ishu', girl:true};  "Vayu (4th Year)" -> year hint
export function readName(raw) {
  let s = (raw || '').trim();
  const girl = /\(\s*w\s*\)/i.test(s);
  s = s.replace(/-?\s*\(\s*w\s*\)/ig, ' ');
  let hint = null;
  const m = s.match(/\(\s*(1st|2nd|3rd|4th|final)[^)]*\)/i);
  if (m) { hint = normYear(m[1]); s = s.replace(m[0], ' '); }
  s = s.replace(/\s{2,}/g, ' ').replace(/[\s,\-]+$/, '').trim();
  return { name: s, girl, hint };
}

export function normYear(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('1') || s.startsWith('first')) return 1;
  if (s.startsWith('2') || s.startsWith('second')) return 2;
  if (s.startsWith('3') || s.startsWith('third')) return 3;
  if (s.startsWith('4') || s.startsWith('four') || s.startsWith('final')) return 4;
  return null;
}

// Reads the source sheet (leader shares a row with the first member) and this
// app's own export (leader gets its own row, plus a Girl column). Column 5 is
// the girl marker when present, so an exported file survives a round trip.
// Returns teams without ids; the database assigns them.
export function parseTeams(text) {
  const rows = parseCSV(text); const out = []; let cur = null;
  for (let i = 1; i < rows.length; i++) {
    const [sno = '', leader = '', member = '', year = '', girlCol = ''] = rows[i].map(x => (x || '').trim());
    if (sno.toUpperCase() === 'UNASSIGNED') break;   // tail section of this app's export
    const flagged = /^w$/i.test(girlCol);
    if (sno) {
      const L = readName(leader);
      // If the leader has the row to itself, the Year column is the leader's.
      const leadYear = L.hint ?? (member === '' ? normYear(year) : null);
      cur = {
        no: sno, draft: false,
        people: [{ name: L.name, girl: L.girl || (member === '' && flagged), year: leadYear, role: 'Leader', branch: '' }]
      };
      out.push(cur);
    }
    if (member && cur) {
      const M = readName(member);
      cur.people.push({ name: M.name, girl: M.girl || flagged, year: M.hint ?? normYear(year), role: 'Member', branch: '' });
    }
  }
  return out;
}

// Reads the source sheet (name in column 2) and the tail section of this app's
// own export, which sits after an UNASSIGNED marker with the name in column 3.
export function parsePool(text) {
  const rows = parseCSV(text); const out = [];
  const mark = rows.findIndex(r => (r[0] || '').trim().toUpperCase() === 'UNASSIGNED');
  const exported = mark >= 0;
  for (let i = exported ? mark + 1 : 1; i < rows.length; i++) {
    const c = rows[i].map(x => (x || '').trim());
    const nm = exported ? c[2] : c[1];
    const yr = exported ? c[3] : c[2];
    const gc = exported ? c[4] : '';
    const br = exported ? c[5] : c[3];
    if (!nm) continue;
    const N = readName(nm);
    out.push({ name: N.name, girl: N.girl || /^w$/i.test(gc || ''), year: N.hint ?? normYear(yr), role: 'Member', branch: br || '' });
  }
  return out;
}

/* ---------- rules ---------- */

export const DEFAULT_RULES = {
  sizeMin: 6, sizeMax: 6,
  y4max: 2,                     // Rule 1
  y1min: 1,                     // Rule 2
  girlMode: 'exactly', girlN: 1, // Rule 3
  y3maxNo4: 2                   // Rule 4
};

// Keeps a rules object from the database or a request body inside sane bounds.
export function sanitiseRules(input) {
  const R = { ...DEFAULT_RULES, ...(input || {}) };
  const int = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  R.sizeMin = int(R.sizeMin, 1, 12, 6);
  R.sizeMax = int(R.sizeMax, 1, 12, 6);
  if (R.sizeMax < R.sizeMin) R.sizeMax = R.sizeMin;
  R.y4max = int(R.y4max, 0, 12, 2);
  R.y1min = int(R.y1min, 0, 12, 1);
  R.girlN = int(R.girlN, 0, 12, 1);
  R.y3maxNo4 = int(R.y3maxNo4, 0, 12, 2);
  if (!['exactly', 'atmost', 'atleast'].includes(R.girlMode)) R.girlMode = 'exactly';
  return R;
}

export function counts(people) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0, 0: 0, girls: 0, n: people.length };
  for (const p of people) { c[p.year || 0]++; if (p.girl) c.girls++; }
  return c;
}

// Every rule checked one at a time, so the interface can show which rule broke
// rather than only that something did. validateTeam is built on this, and the
// error text is identical either way.
export function ruleChecks(team, R) {
  const c = counts(team.people);
  const out = [];
  const add = (id, tag, label, ok, error) => out.push({ id, tag, label, ok, error: ok ? null : error });

  add('size', '\u00a7', `Team size ${R.sizeMin === R.sizeMax ? R.sizeMin : `${R.sizeMin}-${R.sizeMax}`}`,
    c.n >= R.sizeMin && c.n <= R.sizeMax,
    c.n < R.sizeMin
      ? `Short by ${R.sizeMin - c.n}. Team has ${c.n}, needs ${R.sizeMin}.`
      : `Over by ${c.n - R.sizeMax}. Team has ${c.n}, limit is ${R.sizeMax}.`);

  add('y4', '1', `Max ${R.y4max} from 4th year`, c[4] <= R.y4max,
    `Rule 1: ${c[4]} fourth-year members, at most ${R.y4max} allowed.`);

  add('y1', '2', `Min ${R.y1min} from 1st year`, c[1] >= R.y1min,
    `Rule 2: no first-year member. At least ${R.y1min} required.`);

  const girlLabel = { exactly: 'Exactly', atmost: 'At most', atleast: 'At least' }[R.girlMode];
  const girlOk = R.girlMode === 'exactly' ? c.girls === R.girlN
    : R.girlMode === 'atmost' ? c.girls <= R.girlN
      : c.girls >= R.girlN;
  const girlErr = R.girlMode === 'exactly'
    ? `Rule 3: ${c.girls} girl${c.girls === 1 ? '' : 's'}, exactly ${R.girlN} required.`
    : R.girlMode === 'atmost'
      ? `Rule 3: ${c.girls} girls, at most ${R.girlN} allowed.`
      : `Rule 3: ${c.girls} girls, at least ${R.girlN} required.`;
  add('girls', '3', `${girlLabel} ${R.girlN} girl per team`, girlOk, girlErr);

  add('y3', '4', `Max ${R.y3maxNo4} from 3rd year with no 4th`, !(c[4] === 0 && c[3] > R.y3maxNo4),
    `Rule 4: ${c[3]} third-year members with no fourth-year present, at most ${R.y3maxNo4} allowed.`);

  return { checks: out, c };
}

// Returns {errors:[], warnings:[]} for a team.
export function validateTeam(team, R) {
  const { checks, c } = ruleChecks(team, R);
  const e = checks.filter(x => !x.ok).map(x => x.error);
  const w = [];
  if (c[0] > 0) w.push(`Year missing: ${team.people.filter(p => !p.year).map(p => p.name).join(', ')}`);
  return { errors: e, warnings: w, c, checks };
}

// Why a student cannot join a team. null = allowed.
export function blockedReason(team, s, R) {
  const c = counts(team.people);
  if (c.n >= R.sizeMax) return `full at ${R.sizeMax}`;
  if (s.girl && R.girlMode !== 'atleast' && c.girls >= R.girlN) return `already has ${R.girlN} girl`;
  if (s.year === 4 && c[4] + 1 > R.y4max) return `would make ${c[4] + 1} fourth-years`;
  if (s.year === 3 && c[4] === 0 && c[3] + 1 > R.y3maxNo4) return `would make ${c[3] + 1} third-years, no fourth-year`;
  return null;
}

/* ---------- capacity analysis ----------
   How many complete teams can the pool actually produce, and which
   rule is the binding constraint? This is the number the HOD needs. */
export function capacity(pool, R) {
  const girls = pool.filter(p => p.girl).length;
  const nonGirls = pool.length - girls;
  const y1 = pool.filter(p => p.year === 1).length;
  const n = pool.length, size = R.sizeMin;
  const lim = [];
  lim.push({ t: Math.floor(n / size), why: `headcount (${n} students / ${size} per team)` });
  if (R.girlMode === 'exactly') {
    lim.push({ t: R.girlN ? Math.floor(girls / R.girlN) : Infinity, why: `girls available (${girls}), one per team` });
    lim.push({ t: size - R.girlN > 0 ? Math.floor(nonGirls / (size - R.girlN)) : Infinity, why: `boys available (${nonGirls}), ${size - R.girlN} per team` });
  } else if (R.girlMode === 'atleast' && R.girlN > 0) {
    lim.push({ t: Math.floor(girls / R.girlN), why: `girls available (${girls}), at least ${R.girlN} per team` });
  }
  if (R.y1min > 0) lim.push({ t: Math.floor(y1 / R.y1min), why: `first-years available (${y1}), ${R.y1min} per team` });
  lim.sort((a, b) => a.t - b.t);
  return { max: Math.max(0, lim[0].t), binding: lim[0], all: lim, girls, nonGirls, y1, n };
}

/* ---------- auto-builder ----------
   Randomised restarts. Anchor each team on one girl, guarantee a
   first-year, then place the capped years (4th, 3rd) before filling
   the rest. Best run by (complete valid teams, then fewest leftover). */
export function autoBuild(pool, R, wantTeams) {
  const T = Math.max(0, wantTeams | 0);
  if (T === 0) return { teams: [], left: pool.slice(), valid: 0 };
  let best = null;

  for (let trial = 0; trial < 700; trial++) {
    const p = shuffle(pool.slice(), trial + 1);
    const teams = Array.from({ length: T }, () => []);
    const taken = new Set();
    const take = s => { taken.add(s.id); return s; };
    const free = () => p.filter(s => !taken.has(s.id));

    // 1. anchor: the required girls, spread across years
    if (R.girlMode !== 'atmost') {
      const g = free().filter(s => s.girl);
      for (let i = 0; i < T; i++) {
        for (let k = 0; k < R.girlN; k++) {
          const pick = g.find(s => !taken.has(s.id));
          if (pick) teams[i].push(take(pick));
        }
      }
    }
    // 2. capped years first: 4th, then 3rd. Spread thin.
    for (const yv of [4, 3]) {
      for (const s of free().filter(x => x.year === yv)) {
        const dest = bestSlot(teams, s, R);
        if (dest >= 0) teams[dest].push(take(s));
      }
    }
    // 3. guarantee the first-year floor
    for (let i = 0; i < T; i++) {
      while (counts(teams[i])[1] < R.y1min) {
        const pick = free().find(s => s.year === 1 && !blockedReason({ people: teams[i] }, s, R));
        if (!pick) break;
        teams[i].push(take(pick));
      }
    }
    // 4. fill the rest, smallest team first
    for (const s of free()) {
      const dest = bestSlot(teams, s, R);
      if (dest >= 0) teams[dest].push(take(s));
    }

    const built = teams.map((people, i) => ({ no: 'N' + (i + 1), draft: true, people }));
    const valid = built.filter(t => validateTeam(t, R).errors.length === 0).length;
    const left = p.filter(s => !taken.has(s.id));
    const score = valid * 10000 - left.length * 10 - built.reduce((a, t) => a + validateTeam(t, R).errors.length, 0);
    if (!best || score > best.score) best = { score, teams: built, left, valid };
    if (valid === T && left.length <= pool.length - T * R.sizeMin) break;
  }
  // Seat the most senior member first, so the leader is not simply whoever
  // the solver happened to anchor the team on.
  best.teams.forEach(t => {
    t.people = t.people.map(x => ({ ...x })).sort((a, b) => (b.year || 0) - (a.year || 0));
    t.people.forEach((p, i) => p.role = i === 0 ? 'Leader' : 'Member');
  });
  return best;
}

export function bestSlot(teams, s, R) {
  let bi = -1, bn = 1e9;
  for (let i = 0; i < teams.length; i++) {
    if (blockedReason({ people: teams[i] }, s, R)) continue;
    if (teams[i].length < bn) { bn = teams[i].length; bi = i; }
  }
  return bi;
}

// deterministic shuffle so a rebuild with the same inputs is reproducible
export function shuffle(a, seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ---------- data issues ---------- */

export const nameKey = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());
// Names reach this file from an imported sheet, so they are escaped before
// going anywhere near innerHTML.
const e = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function dataIssues(state) {
  const out = [];
  const seen = new Map();
  for (const t of state.teams) for (const p of t.people) {
    const k = nameKey(p.name); if (!k) continue;
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(`Team ${t.no}`);
  }
  for (const [k, where] of seen) if (where.length > 1)
    out.push({ lvl: 'warn', txt: `<b>${e(titleCase(k))}</b> appears on ${where.length} teams`, where: where.join(', ') + '. Same person, or different students sharing a first name? Roll numbers would settle it.' });

  for (const s of state.pool) {
    const k = nameKey(s.name);
    if (seen.has(k)) out.push({ lvl: 'bad', txt: `<b>${e(s.name)}</b> is in the unassigned list but already placed`, where: seen.get(k).join(', ') + '. One of the two sheets is stale.' });
  }
  const noYear = [];
  for (const t of state.teams) for (const p of t.people) if (!p.year) noYear.push(`${p.name} (T${t.no})`);
  for (const s of state.pool) if (!s.year) noYear.push(`${s.name} (pool)`);
  if (noYear.length) out.push({ lvl: 'bad', txt: `<b>${noYear.length} students have no year recorded</b>`, where: noYear.join(', ') + '. Click the year chip on a row to set it.' });

  const noGirl = state.teams.filter(t => !t.people.some(p => p.girl));
  if (noGirl.length) out.push({ lvl: 'warn', txt: `<b>${noGirl.length} team${noGirl.length === 1 ? '' : 's'} have no girl marked</b>`, where: 'Teams ' + noGirl.map(t => e(t.no)).join(', ') + '. Either genuinely all-boys, or the ( W ) marker is missing from the sheet.' });
  return out;
}

/* ---------- export ---------- */

export function toCSV(state, R) {
  const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
  const rows = [['S.No', 'Team Leader', 'Team Member', 'Year', 'Girl', 'Status']];
  for (const t of state.teams) {
    const v = validateTeam(t, R);
    const status = v.errors.length ? v.errors.join(' | ') : 'Cleared';
    t.people.forEach((p, i) => {
      rows.push([i === 0 ? t.no : '', i === 0 ? p.name : '', i === 0 ? '' : p.name,
      p.year ? YEAR_LABEL[p.year] + ' Year' : '', p.girl ? 'W' : '', i === 0 ? status : '']);
    });
    rows.push(['', '', '', '', '', '']);
  }
  if (state.pool.length) {
    rows.push(['UNASSIGNED', '', '', '', '', '']);
    state.pool.forEach(s => rows.push(['', '', s.name, s.year ? YEAR_LABEL[s.year] + ' Year' : '', s.girl ? 'W' : '', s.branch || '']));
  }
  return rows.map(r => r.map(q).join(',')).join('\n');
}
