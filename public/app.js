/* ============================================================
   SIH 2026 RBCET - Team Register (browser)

   The register lives in Postgres. This file renders it and asks the
   server to change it; every mutating call returns the register as it
   now stands, so what is on screen is always what is stored.
   ============================================================ */

import {
  YEAR_LABEL, DEFAULT_RULES, validateTeam, blockedReason,
  capacity, dataIssues
} from '/shared/domain.js';

/* ---------- state ---------- */

let state = { teams: [], pool: [], rules: { ...DEFAULT_RULES } };
let session = { authRequired: false, signedIn: true };
let filter = 'all';
let inflight = 0;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- icons ---------- */

const ICON = {
  lead: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.4 5.3 5.6.6-4.2 3.9 1.2 5.7L12 15.7 7 18.5l1.2-5.7L4 8.9l5.6-.6z"/></svg>',
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 5l-4 4 4 4M4 9h13M16 19l4-4-4-4M20 15H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v13M6 13l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

/* ---------- talking to the server ---------- */

function busy(on) {
  inflight += on ? 1 : -1;
  document.body.classList.toggle('busy', inflight > 0);
}

// Every call goes through here so one place handles the passcode gate, a lost
// connection and the "here is the register as it now stands" reply.
async function api(path, { method = 'GET', body, retryAfterSignIn } = {}) {
  busy(true);
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : {};

    if (res.status === 401 && data.needsAuth) {
      session.signedIn = false;
      applySession();
      const ok = await dlgSignIn();
      if (ok && retryAfterSignIn !== false) return api(path, { method, body, retryAfterSignIn: false });
      throw new Error('Signed out. That change was not made.');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);

    if (data.state) { state = data.state; if (data.state.session) session = data.state.session; adopt(); }
    return data;
  } catch (err) {
    if (err instanceof TypeError) {
      banner('The register could not reach the server. Your last change was not saved.', 'Try again', () => refresh(), 'bad');
      throw new Error('No connection to the server.');
    }
    throw err;
  } finally {
    busy(false);
  }
}

function adopt() {
  state.rules = { ...DEFAULT_RULES, ...state.rules };
  applySession();
  render();
}

async function refresh() {
  const data = await api('/api/state');
  state = data;
  session = data.session || session;
  clearBanner();
  adopt();
}

async function act(path, opts) {
  try {
    const data = await api(path, opts);
    if (data.message) toast(data.message);
    return data;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

/* ---------- theme ---------- */

$('#btn-theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('sih-theme', root.dataset.theme); } catch (e) {}
});

/* ---------- session ---------- */

function applySession() {
  const locked = session.authRequired && !session.signedIn;
  document.body.classList.toggle('readonly', locked);
  const btn = $('#btn-session');
  btn.hidden = !session.authRequired;
  btn.textContent = locked ? 'Sign in' : 'Sign out';
  ['#btn-import', '#btn-build', '#btn-reset', '#btn-confirm', '#btn-add'].forEach(sel => {
    const el = $(sel); if (el) el.disabled = locked;
  });
  if (locked) banner('You are viewing the register. Sign in with the coordinator passcode to make changes.', 'Sign in', dlgSignIn);
  else clearBanner();
}

function dlgSignIn() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    openDlg('Coordinator sign-in',
      `<div class="field">
         <label for="pw">Passcode</label>
         <input class="text" id="pw" type="password" autocomplete="current-password" placeholder="Given to the coordinators">
       </div>
       <div id="pw-err" style="font-size:11.5px;color:var(--bad);min-height:16px;margin-bottom:8px"></div>
       <div class="hint">Anyone can read the register. Only a signed-in coordinator can move a student, change a rule or import a sheet.</div>`,
      `<button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="do-signin">Sign in</button>`);

    const submit = async () => {
      try {
        const res = await fetch('/api/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: $('#pw').value })
        });
        const data = await res.json();
        if (!res.ok) { $('#pw-err').textContent = data.error || 'Sign-in failed.'; $('#pw').select(); return; }
        session = { authRequired: data.authRequired, signedIn: true };
        closeDlg(); done(true);
        await refresh();
        toast('Signed in. You can now change the register.');
      } catch { $('#pw-err').textContent = 'Could not reach the server.'; }
    };

    $('#do-signin').addEventListener('click', submit);
    $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    $('#dlg-f').querySelector('[data-close]').addEventListener('click', () => { closeDlg(); done(false); });
    dlg.addEventListener('close', () => done(false), { once: true });
    setTimeout(() => $('#pw')?.focus(), 30);
  });
}

$('#btn-session').addEventListener('click', async () => {
  if (session.authRequired && !session.signedIn) return dlgSignIn();
  await fetch('/api/session', { method: 'DELETE' });
  session.signedIn = false;
  await refresh();
  toast('Signed out. The register is now read-only for you.');
});

/* ---------- banner ---------- */

function banner(text, label, onClick, kind = 'info') {
  const el = $('#banner');
  el.className = 'banner' + (kind === 'bad' ? ' bad' : '');
  el.innerHTML = `<span>${esc(text)}</span>`;
  if (label) {
    const b = document.createElement('button');
    b.className = 'btn sm'; b.textContent = label;
    b.addEventListener('click', onClick);
    el.appendChild(b);
  }
  el.hidden = false;
}
function clearBanner() { $('#banner').hidden = true; }

/* ---------- render ---------- */

function render() {
  renderMetrics(); renderRules(); renderCap(); renderTeams(); renderPool(); renderIssues();
  $('#btn-confirm').hidden = !state.teams.some(t => t.draft);
}

function renderMetrics() {
  const R = state.rules;
  const v = state.teams.map(t => validateTeam(t, R));
  const ok = v.filter(x => x.errors.length === 0).length;
  const total = state.teams.length;
  const placed = state.teams.reduce((a, t) => a + t.people.length, 0);
  const girls = state.teams.reduce((a, t) => a + t.people.filter(p => p.girl).length, 0);
  const everyone = placed + state.pool.length;

  // Each metric carries a hairline bar showing its share, so the numbers
  // have a shape as well as a value.
  const rows = [
    ['Teams on register', total, '', null],
    ['Clear of all rules', ok, 'ok', total ? ok / total : 0],
    ['Flagged', total - ok, (total - ok) ? 'bad' : '', total ? (total - ok) / total : 0],
    ['Students placed', placed, '', everyone ? placed / everyone : 0],
    ['Girls placed', girls, '', placed ? girls / placed : 0],
    ['Awaiting a team', state.pool.length, state.pool.length ? 'bad' : 'ok', everyone ? state.pool.length / everyone : 0],
  ];
  $('#strip').innerHTML = rows.map(([k, val, cls, frac]) => `
    <div class="metric ${cls}">
      <div class="metric-k">${k}</div>
      <div class="metric-v">${val}</div>
      ${frac === null ? '' : `<div class="metric-bar"><i style="width:${Math.round(Math.min(1, frac) * 100)}%"></i></div>`}
    </div>`).join('');
}

function renderRules() {
  const R = state.rules;
  const rows = [
    ['1', `No more than <input class="inline" type="number" min="0" max="6" value="${R.y4max}" data-rule="y4max"> members from <b>4th year</b>.`],
    ['2', `At least <input class="inline" type="number" min="0" max="6" value="${R.y1min}" data-rule="y1min"> member from <b>1st year</b>.`],
    ['3', `<select class="inline" data-rule="girlMode">
            <option value="exactly"${R.girlMode === 'exactly' ? ' selected' : ''}>Exactly</option>
            <option value="atmost"${R.girlMode === 'atmost' ? ' selected' : ''}>At most</option>
            <option value="atleast"${R.girlMode === 'atleast' ? ' selected' : ''}>At least</option>
          </select> <input class="inline" type="number" min="0" max="6" value="${R.girlN}" data-rule="girlN"> <b>girl</b> per team.`],
    ['4', `If a team has <b>no 4th year</b>, at most <input class="inline" type="number" min="0" max="6" value="${R.y3maxNo4}" data-rule="y3maxNo4"> members from <b>3rd year</b>.`],
    ['&sect;', `Team size <input class="inline" type="number" min="1" max="12" value="${R.sizeMin}" data-rule="sizeMin"> to <input class="inline" type="number" min="1" max="12" value="${R.sizeMax}" data-rule="sizeMax">, <b>leader included</b>.`],
  ];
  $('#rules').innerHTML = rows.map(([n, t]) => `<div class="rule"><span class="rule-n">${n}</span><span>${t}</span></div>`).join('')
    + `<div class="note">Rule 4 is read per team: the cap on 3rd-years applies to a team that has no 4th-year on it. Change any number and every team is re-checked at once.</div>`;

  $('#rules').querySelectorAll('[data-rule]').forEach(el => {
    el.addEventListener('change', async () => {
      const k = el.dataset.rule;
      const next = { ...state.rules, [k]: el.tagName === 'SELECT' ? el.value : Number(el.value) };
      if (k === 'sizeMin' && next.sizeMax < next.sizeMin) next.sizeMax = next.sizeMin;
      state.rules = next; render();
      await act('/api/rules', { method: 'PUT', body: next });
    });
  });
}

function renderCap() {
  const R = state.rules;
  const cap = capacity(state.pool, R);
  const alt = capacity(state.pool, { ...R, sizeMin: Math.max(1, R.sizeMin - 1) });
  let html = `<div class="cap-figure">
      <span class="cap-n">${cap.max}</span>
      <span class="cap-cap">complete team${cap.max === 1 ? '' : 's'} of ${R.sizeMin}<br>can be formed under<br>the current rules</span>
    </div>
    <div class="cap-split">
      <span>${cap.n} waiting</span><span>${cap.girls} girls</span><span>${cap.nonGirls} boys</span><span>${cap.y1} first-year</span>
    </div>`;
  if (cap.n > 0) {
    html += `<div class="note">Binding constraint: <b>${esc(cap.binding.why)}</b>.`;
    if (alt.max > cap.max) html += ` Allowing one smaller team of ${R.sizeMin - 1} would yield <b>${alt.max}</b> instead.`;
    const spare = cap.n - cap.max * R.sizeMin;
    if (spare > 0) html += ` <b>${spare}</b> student${spare === 1 ? '' : 's'} would remain over, and can only be placed by joining teams that are short.`;
    html += `</div>`;
  }
  $('#cap').innerHTML = html;
}

function renderTeams() {
  const R = state.rules;
  const list = state.teams.filter(t => {
    if (filter === 'all') return true;
    const ok = validateTeam(t, R).errors.length === 0;
    return filter === 'bad' ? !ok : ok;
  });
  $('#teams-count').textContent = `${list.length} of ${state.teams.length}`;
  $$('#filters button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.filter === filter)));

  if (!list.length) { $('#teams').innerHTML = `<div class="empty">No teams match this filter.</div>`; return; }

  $('#teams').innerHTML = list.map(t => {
    const v = validateTeam(t, R), c = v.c, bad = v.errors.length > 0;
    const lead = t.people[0];

    // One pip per rule. Reading five pips is faster than reading five sentences.
    const pips = v.checks.map(k =>
      `<span class="pip ${k.ok ? '' : 'bad'}" title="${esc(k.ok ? k.label + ' - passes' : k.error)}"></span>`).join('');

    const rows = t.people.map((p, i) => `
      <div class="row ${p.role === 'Leader' ? 'lead' : ''}">
        <span class="row-i">${i + 1}</span>
        <span class="row-name">${esc(p.name) || '<i style="color:var(--bad)">unnamed</i>'}</span>
        ${p.role === 'Leader' ? '<span class="row-lead-tag">Lead</span>' : ''}
        <span class="row-gap"></span>
        <button class="wbtn ${p.girl ? 'on' : 'off'}" data-act="wtoggle" data-s="${p.id}"
          title="${p.girl ? 'Marked as a girl. Click to unmark.' : 'Click to mark as a girl ( W )'}">W</button>
        <button class="yr y${p.year || 0}" data-act="year" data-s="${p.id}" title="Set year of study">${p.year ? YEAR_LABEL[p.year] : 'yr ?'}</button>
        <span class="row-acts">
          ${p.role === 'Leader' ? '' : `<button class="mini" data-act="lead" data-s="${p.id}" title="Make team leader">${ICON.lead}</button>`}
          <button class="mini" data-act="move" data-s="${p.id}" title="Move to another team">${ICON.move}</button>
          <button class="mini" data-act="pool" data-s="${p.id}" title="Send back to the unassigned pool">${ICON.down}</button>
        </span>
      </div>`).join('');

    return `<article class="team ${t.draft ? 'draft' : ''} ${bad ? 'bad' : 'ok'}">
      <div class="team-head">
        <span class="team-no">${esc(t.no)}</span>
        <div class="team-id">
          <div class="team-role">${t.draft ? 'Proposed' : 'Team leader'}</div>
          <div class="team-lead">${esc(lead ? lead.name : '-')}</div>
        </div>
        <div class="pips">${pips}</div>
        <button class="team-x" data-act="dissolve" data-t="${t.id}" title="Dissolve this team and return everyone to the pool">${ICON.x}</button>
      </div>
      <div class="roster">${rows}</div>
      <div class="team-foot">
        <div class="compo">
          <span class="n">${c.n} members</span><span class="dot"></span>
          ${[1, 2, 3, 4].map(y => `<span class="tag${c[y] ? '' : ' zero'}">${YEAR_LABEL[y]} ${c[y]}</span>`).join('')}
          ${c[0] ? `<span class="tag">? ${c[0]}</span>` : ''}
          <span class="dot"></span><span class="tag w">W ${c.girls}</span>
        </div>
        ${(v.errors.length || v.warnings.length) ? `<div class="flags">
          ${v.errors.map(e => `<div class="flag"><span>${esc(e)}</span></div>`).join('')}
          ${v.warnings.map(e => `<div class="flag warn"><span>${esc(e)}</span></div>`).join('')}
        </div>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderPool() {
  $('#pool-n').textContent = plural(state.pool.length, 'student');
  if (!state.pool.length) { $('#pool').innerHTML = `<div class="empty">Everyone has a team.</div>`; return; }
  const groups = [[4, 'Final / 4th year'], [3, '3rd year'], [2, '2nd year'], [1, '1st year'], [0, 'Year not recorded']];
  $('#pool').innerHTML = groups.map(([y, label]) => {
    const g = state.pool.filter(s => (s.year || 0) === y);
    if (!g.length) return '';
    const girls = g.filter(s => s.girl).length;
    return `<div class="pool-group">
      <div class="pool-head">${label}<span class="meta">${g.length}${girls ? ` &middot; ${girls} W` : ''}</span></div>
      <div class="chips">${g.map(s => `<span class="chip">
        <button class="chip-nm" data-act="place" data-s="${s.id}" title="${esc(s.branch || '') || 'Place on a team'}">${esc(s.name)}</button>
        <button class="wbtn ${s.girl ? 'on' : 'off'}" data-act="wtoggle" data-s="${s.id}"
          title="${s.girl ? 'Marked as a girl. Click to unmark.' : 'Click to mark as a girl ( W )'}">W</button>
        <button class="chip-x" data-act="drop" data-s="${s.id}" title="Delete ${esc(s.name)} from the register">${ICON.x}</button>
      </span>`).join('')}</div>
    </div>`;
  }).join('');
}

function renderIssues() {
  const iss = dataIssues(state);
  $('#iss-n').textContent = iss.length ? `${iss.length} to resolve` : 'none';
  $('#issues').innerHTML = iss.length
    ? iss.map(i => `<div class="issue ${i.lvl === 'warn' ? 'warn' : ''}"><span class="issue-dot"></span><div>${i.txt}<div class="issue-where">${esc(i.where)}</div></div></div>`).join('')
    : `<div class="empty">No contradictions found between the two sheets.</div>`;
}

/* ---------- interaction ---------- */

function findStudent(id) {
  for (const t of state.teams) { const i = t.people.findIndex(p => String(p.id) === String(id)); if (i >= 0) return { s: t.people[i], team: t, i }; }
  const j = state.pool.findIndex(p => String(p.id) === String(id));
  if (j >= 0) return { s: state.pool[j], team: null, i: j };
  return null;
}

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const what = b.dataset.act, id = b.dataset.s;
  if (what === 'year') return dlgYear(id);
  if (what === 'move' || what === 'place') return dlgMove(id);
  if (what === 'dissolve') return dlgDissolve(b.dataset.t);
  if (what === 'drop') return dlgDrop(id);
  if (what === 'lead') return act(`/api/students/${id}/lead`, { method: 'POST' });
  if (what === 'pool') return act(`/api/students/${id}/move`, { method: 'POST', body: { to: 'pool' } });
  if (what === 'wtoggle') {
    const f = findStudent(id); if (!f) return;
    // Marking someone can push their team over rule 3, which is correct: the
    // register should show the truth and flag it, not refuse the correction.
    return act(`/api/students/${id}`, { method: 'PATCH', body: { girl: !f.s.girl } }).then(r => {
      if (!r) return;
      const g = findStudent(id);
      const t = g && g.team ? ` Team ${g.team.no} now has ${g.team.people.filter(p => p.girl).length}.` : '';
      toast(`${f.s.name} ${g && g.s.girl ? 'marked as a girl ( W ).' : 'no longer marked as a girl.'}${t}`);
    });
  }
});

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('[data-filter]'); if (!b) return;
  filter = b.dataset.filter;
  renderTeams();
});

/* ---------- dialogs ---------- */

const dlg = $('#dlg');
function openDlg(title, body, foot) {
  $('#dlg-t').textContent = title;
  $('#dlg-b').innerHTML = body;
  $('#dlg-f').innerHTML = foot || '';
  dlg.showModal();
}
function closeDlg() { dlg.close(); }
dlg.addEventListener('click', e => { if (e.target === dlg) closeDlg(); });

function dlgYear(id) {
  const f = findStudent(id); if (!f) return;
  openDlg(`Year of study - ${f.s.name}`,
    [1, 2, 3, 4].map(y => `<button class="dest" data-y="${y}">
        <span class="yr y${y}">${YEAR_LABEL[y]}</span>
        <span class="dest-main">${y === 4 ? 'Fourth / final year' : YEAR_LABEL[y] + ' year'}</span>
      </button>`).join('')
    + `<button class="dest" data-y="0"><span class="yr y0">yr ?</span><span class="dest-main">Not known</span></button>`,
    `<button class="btn ghost" data-close>Cancel</button>`);
  $('#dlg-b').querySelectorAll('[data-y]').forEach(el => el.addEventListener('click', () => {
    const year = Number(el.dataset.y) || null;
    closeDlg();
    act(`/api/students/${id}`, { method: 'PATCH', body: { year } });
  }));
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
}

function dlgMove(id) {
  const f = findStudent(id); if (!f) return;
  const R = state.rules, s = f.s;
  const opts = state.teams.filter(t => t !== f.team).map(t => {
    const why = blockedReason(t, s, R);
    const lead = t.people[0] ? t.people[0].name : '-';
    return `<button class="dest" data-t="${t.id}" ${why ? 'disabled' : ''}>
      <span class="dest-mark">${why ? '&mdash;' : '&#10003;'}</span>
      <span class="dest-main"><b>Team ${esc(t.no)}</b> <span style="color:var(--text-3)">${esc(lead)} &middot; ${plural(t.people.length, 'member')}</span></span>
      ${why ? `<span class="dest-why">${esc(why)}</span>` : ''}
    </button>`;
  }).join('');
  const allowed = state.teams.filter(t => t !== f.team && !blockedReason(t, s, R)).length;
  openDlg(`Move ${s.name}${s.girl ? ' (W)' : ''}`,
    `<div class="hint" style="margin-bottom:12px">${s.year ? YEAR_LABEL[s.year] + ' year' : 'Year not recorded'} &middot; ${allowed} of ${state.teams.length} teams can take this student without breaking a rule.${s.year ? '' : ' <b style="color:var(--bad)">Year is unknown, so rules 1 and 4 cannot be checked.</b>'}</div>`
    + opts
    + (f.team ? `<button class="dest" data-t="pool"><span class="dest-mark">&#8595;</span><span class="dest-main">Unassigned pool</span></button>` : '')
    + `<button class="dest danger" data-t="delete"><span class="dest-mark">&#10005;</span><span class="dest-main">Delete this record from the register</span><span class="dest-why">for duplicates</span></button>`,
    `<button class="btn ghost" data-close>Cancel</button>`);
  $('#dlg-b').querySelectorAll('[data-t]').forEach(el => el.addEventListener('click', () => {
    const to = el.dataset.t;
    closeDlg();
    act(`/api/students/${id}/move`, { method: 'POST', body: { to } });
  }));
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
}

// Deleting a student is the one move with nothing behind it, so it asks first
// and says plainly that the record is gone rather than moved.
function dlgDrop(id) {
  const f = findStudent(id); if (!f) return;
  const s = f.s;
  openDlg(`Delete ${s.name}`,
    `<p><b>${esc(s.name)}</b>${s.girl ? ' (W)' : ''} &middot; ${s.year ? YEAR_LABEL[s.year] + ' year' : 'year not recorded'}${s.branch ? ' &middot; ' + esc(s.branch) : ''}
       leaves the register altogether. This is not the same as sending them back to the pool: the record is removed,
       and the only way back is to import the sheet again.</p>
     <div class="hint" style="margin-top:12px">Use this for a duplicate, for someone who appears on a team and in the unassigned sheet at once, or for a student who has withdrawn.</div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="do-drop">Delete record</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-drop').addEventListener('click', () => {
    closeDlg();
    act(`/api/students/${id}/move`, { method: 'POST', body: { to: 'delete' } });
  });
}

function dlgDissolve(tid) {
  const t = state.teams.find(x => String(x.id) === String(tid)); if (!t) return;
  openDlg(`Dissolve Team ${t.no}`,
    `<p>All <b>${t.people.length}</b> members (${esc(t.people.map(p => p.name).join(', '))}) go back to the unassigned pool and Team ${esc(t.no)} leaves the register.</p>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="do-dis">Dissolve team</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-dis').addEventListener('click', () => { closeDlg(); act(`/api/teams/${tid}`, { method: 'DELETE' }); });
}

/* ---------- toolbar ---------- */

$('#btn-build').addEventListener('click', () => {
  const R = state.rules, cap = capacity(state.pool, R);
  if (!state.pool.length) return toast('The unassigned pool is empty.');
  openDlg('Auto-build teams from the unassigned pool',
    `<div class="note" style="margin-top:0">
       <b>${cap.n}</b> students in the pool: ${cap.girls} girls, ${cap.nonGirls} boys, ${cap.y1} first-year.
       At ${R.sizeMin} per team the rules allow at most <b>${cap.max}</b> complete team${cap.max === 1 ? '' : 's'}.
       Binding constraint: <b>${esc(cap.binding.why)}</b>.
     </div>
     <div class="field" style="margin-top:16px">
       <label for="nteams">Number of teams to build</label>
       <input class="inline" id="nteams" type="number" min="1" max="20" value="${Math.max(1, cap.max)}" style="width:64px">
       <span class="hint">&nbsp;asking for more than ${cap.max} will produce teams that are flagged</span>
     </div>
     <div class="hint">
       Each proposed team is anchored on one girl, guaranteed a first-year, and the capped years are spread before the rest are filled.
       Proposals appear with a dashed edge and numbers N1, N2 and so on. They stay drafts until you press Confirm proposals.
     </div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="do-build">Build</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-build').addEventListener('click', () => {
    const count = Math.max(1, Number($('#nteams').value) || 1);
    closeDlg();
    act('/api/teams/autobuild', { method: 'POST', body: { count } });
  });
});

$('#btn-confirm').addEventListener('click', () => {
  const drafts = state.teams.filter(t => t.draft);
  openDlg('Confirm the proposed teams',
    `<p><b>${drafts.length}</b> proposed team${drafts.length === 1 ? '' : 's'} (${esc(drafts.map(t => t.no).join(', '))})
       join the register for good and are renumbered after the existing teams.
       Members stay where they are and can still be moved afterwards.</p>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="do-confirm">Confirm</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-confirm').addEventListener('click', () => { closeDlg(); act('/api/teams/confirm', { method: 'POST' }); });
});

$('#btn-import').addEventListener('click', () => {
  openDlg('Import CSV',
    `<div class="field"><label for="in-teams">Teams sheet</label>
       <textarea class="paste" id="in-teams" placeholder="S.No,Team Leader,Team Member,Year&#10;1,Shourya,Alankrit,2nd Year&#10;,,Ishu ( W ),1st Year"></textarea></div>
     <div class="field"><label for="in-pool">Unassigned students sheet</label>
       <textarea class="paste" id="in-pool" placeholder="S.No,Student Name,Year,Branch/Notes&#10;1,Nisha ( W ),1st Year,CSE + AI"></textarea></div>
     <div class="hint">
       Paste from the Google Sheet, or drop a .csv file on either box. Mark girls by writing <b>( W )</b> after the name.
       Leave a box empty to keep the sheet that is already loaded. This replaces the stored register for everyone.
     </div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="do-import">Replace register</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  ['in-teams', 'in-pool'].forEach(idd => {
    const el = document.getElementById(idd);
    el.addEventListener('dragover', e => { e.preventDefault(); });
    el.addEventListener('drop', e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0]; if (!f) return;
      const r = new FileReader(); r.onload = () => { el.value = r.result; }; r.readAsText(f);
    });
  });
  $('#do-import').addEventListener('click', () => {
    const teamsCsv = $('#in-teams').value.trim(), poolCsv = $('#in-pool').value.trim();
    if (!teamsCsv && !poolCsv) return toast('Nothing pasted.', true);
    closeDlg();
    act('/api/import', { method: 'POST', body: { teamsCsv, poolCsv } });
  });
});

// A student who is on neither sheet: a late walk-in, or someone the sheets
// missed. They go into the pool, and are placed from there like anyone else.
$('#btn-add').addEventListener('click', () => {
  let year = null, girl = false;
  openDlg('Add a student to the unassigned pool',
    `<div class="field">
       <label for="new-name">Name</label>
       <input class="text" id="new-name" placeholder="As it should appear on the register" autocomplete="off">
     </div>
     <div class="field">
       <label>Year of study</label>
       <div class="pick" id="new-year">
         ${[1, 2, 3, 4].map(y => `<button type="button" data-y="${y}" aria-pressed="false">${YEAR_LABEL[y]}</button>`).join('')}
         <button type="button" data-y="0" aria-pressed="true">Not known</button>
       </div>
     </div>
     <div class="field">
       <label for="new-branch">Branch or note <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
       <input class="text" id="new-branch" placeholder="CSE + AI" autocomplete="off">
     </div>
     <div class="field">
       <button type="button" class="wswitch" id="new-girl" aria-pressed="false">
         <span class="box">&#10003;</span> Mark as a girl ( W )
       </button>
     </div>
     <div id="new-err" style="font-size:11.5px;color:var(--bad);min-height:16px"></div>
     <div class="hint">They join the pool, not a team. Place them from there, or let Auto-build do it.</div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="do-add">Add student</button>`);

  $('#new-year').addEventListener('click', e => {
    const b = e.target.closest('[data-y]'); if (!b) return;
    year = Number(b.dataset.y) || null;
    $$('#new-year [data-y]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  });
  const wbtn = $('#new-girl');
  wbtn.addEventListener('click', () => { girl = !girl; wbtn.setAttribute('aria-pressed', String(girl)); });

  const submit = async () => {
    const name = $('#new-name').value.trim();
    if (!name) { $('#new-err').textContent = 'A name is required.'; $('#new-name').focus(); return; }
    const branch = $('#new-branch').value.trim();
    closeDlg();
    await act('/api/students', { method: 'POST', body: { name, year, girl, branch } });
  };
  $('#do-add').addEventListener('click', submit);
  $('#new-name').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  setTimeout(() => $('#new-name')?.focus(), 30);
});

$('#btn-export').addEventListener('click', () => {
  // The server writes the CSV from what is stored, not from this tab.
  window.location.href = '/api/export.csv';
  toast('CSV exported.');
});

$('#btn-reset').addEventListener('click', () => {
  openDlg('Reset the register',
    `<p>This discards every move, proposed team and year recorded in the database, and reloads the two sheets exactly as they were shipped. It affects everyone using the register, not just this tab.</p>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="do-reset">Reset everything</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-reset').addEventListener('click', () => { closeDlg(); act('/api/reset', { method: 'POST' }); });
});

/* ---------- toast ---------- */

let toastT;
function toast(msg, bad = false) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el); clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), bad ? 6000 : 3600);
}

/* ---------- start ---------- */

// Another coordinator may be working at the same time, so pick up their
// changes whenever this tab comes back to the front.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !inflight) refresh().catch(() => {});
});

refresh().catch(err => {
  banner(err.message || 'The register could not be loaded.', 'Retry', () => refresh().catch(() => {}), 'bad');
});
