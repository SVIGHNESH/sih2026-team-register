/* ============================================================
   SIH 2026 RBCET - Team Register (browser)

   The register lives in Postgres. This file renders it and asks the
   server to change it; every mutating call returns the register as it
   now stands, so what is on screen is always what is stored.
   ============================================================ */

import {
  YEAR_LABEL, DEFAULT_RULES, counts, validateTeam, blockedReason,
  capacity, dataIssues
} from '/shared/domain.js';

/* ---------- talking to the server ---------- */

let state = { teams: [], pool: [], rules: { ...DEFAULT_RULES } };
let session = { authRequired: false, signedIn: true };
let filter = 'all';
let inflight = 0;

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const title = s => s.replace(/\b\w/g, c => c.toUpperCase());

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
      banner('The register could not reach the server. Your last change was not saved.',
        'Try again', () => refresh());
      throw new Error('No connection to the server.');
    }
    throw err;
  } finally {
    busy(false);
  }
}

// Applies a freshly loaded register, keeping filter and session in step.
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

// Runs a mutation and reports what the server said it did.
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

/* ---------- session ---------- */

function applySession() {
  const locked = session.authRequired && !session.signedIn;
  document.body.classList.toggle('readonly', locked);
  const btn = $('#btn-session');
  btn.hidden = !session.authRequired;
  btn.textContent = locked ? 'Sign in' : 'Sign out';
  ['#btn-import', '#btn-build', '#btn-reset', '#btn-confirm'].forEach(sel => {
    const el = $(sel); if (el) el.disabled = locked;
  });
  if (locked) banner('You are viewing the register. Sign in with the coordinator passcode to make changes.', 'Sign in', dlgSignIn, 'info');
  else clearBanner();
}

function dlgSignIn() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    openDlg('Coordinator sign-in',
      `<div class="field">
         <label>Passcode</label>
         <input class="text" id="pw" type="password" autocomplete="current-password" placeholder="Given to the coordinators">
       </div>
       <div id="pw-err" style="font-size:11px;color:var(--seal);min-height:15px"></div>
       <div style="font-size:11px;color:var(--ink-2);line-height:1.5">
         Anyone can read the register. Only a signed-in coordinator can move a student, change a rule or import a sheet.
       </div>`,
      `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="do-signin">Sign in</button>`);

    const submit = async () => {
      const password = $('#pw').value;
      try {
        const res = await fetch('/api/session', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
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

function banner(text, label, onClick, kind = 'bad') {
  const el = $('#banner');
  el.className = 'banner' + (kind === 'info' ? ' info' : '');
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
  renderStrip(); renderRules(); renderCap(); renderTeams(); renderPool(); renderIssues();
  $('#btn-confirm').hidden = !state.teams.some(t => t.draft);
}

function renderStrip() {
  const R = state.rules;
  const v = state.teams.map(t => validateTeam(t, R));
  const ok = v.filter(x => x.errors.length === 0).length;
  const students = state.teams.reduce((a, t) => a + t.people.length, 0);
  const girls = state.teams.reduce((a, t) => a + t.people.filter(p => p.girl).length, 0);
  $('#strip').innerHTML = [
    ['Teams on register', state.teams.length, ''],
    ['Clear of all rules', ok, 'good'],
    ['Flagged', state.teams.length - ok, (state.teams.length - ok) ? 'alert' : ''],
    ['Students placed', students, ''],
    ['Girls placed', girls, ''],
    ['Awaiting a team', state.pool.length, state.pool.length ? 'alert' : 'good'],
  ].map(([k, val, cls]) => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${val}</div></div>`).join('');
}

function renderRules() {
  const R = state.rules;
  const rows = [
    ['1', `No more than <input class="inline num" type="number" min="0" max="6" value="${R.y4max}" data-rule="y4max"> members from <b>4th year</b>.`],
    ['2', `At least <input class="inline num" type="number" min="0" max="6" value="${R.y1min}" data-rule="y1min"> member from <b>1st year</b>.`],
    ['3', `<select class="inline" data-rule="girlMode">
            <option value="exactly"${R.girlMode === 'exactly' ? ' selected' : ''}>Exactly</option>
            <option value="atmost"${R.girlMode === 'atmost' ? ' selected' : ''}>At most</option>
            <option value="atleast"${R.girlMode === 'atleast' ? ' selected' : ''}>At least</option>
          </select> <input class="inline num" type="number" min="0" max="6" value="${R.girlN}" data-rule="girlN"> <b>girl</b> per team.`],
    ['4', `If a team has <b>no 4th year</b>, at most <input class="inline num" type="number" min="0" max="6" value="${R.y3maxNo4}" data-rule="y3maxNo4"> members from <b>3rd year</b>.`],
    ['&sect;', `Team size <input class="inline num" type="number" min="1" max="12" value="${R.sizeMin}" data-rule="sizeMin"> to <input class="inline num" type="number" min="1" max="12" value="${R.sizeMax}" data-rule="sizeMax">, <b>leader included</b>.`],
  ];
  $('#rules').innerHTML = rows.map(([n, t]) => `<div class="rule-row"><div class="rn">${n}</div><div class="rt">${t}</div></div>`).join('')
    + `<div class="bind" style="margin-top:10px">Rule 4 is read per team: the cap on 3rd-years applies to a team that has no 4th-year on it. Change any number above and every team is re-checked at once.</div>`;

  $('#rules').querySelectorAll('[data-rule]').forEach(el => {
    el.addEventListener('change', async () => {
      const k = el.dataset.rule;
      const next = { ...state.rules, [k]: el.tagName === 'SELECT' ? el.value : Number(el.value) };
      if (k === 'sizeMin' && next.sizeMax < next.sizeMin) next.sizeMax = next.sizeMin;
      // Show the new number at once, then let the server's answer settle it.
      state.rules = next; render();
      await act('/api/rules', { method: 'PUT', body: next });
    });
  });
}

function renderCap() {
  const cap = capacity(state.pool, state.rules);
  const R = state.rules;
  const alt = capacity(state.pool, { ...R, sizeMin: Math.max(1, R.sizeMin - 1) });
  let html = `<div class="figure">
      <span class="big">${cap.max}</span>
      <span class="fig-cap">complete team${cap.max === 1 ? '' : 's'}<br>of ${R.sizeMin} can be formed<br>under the current rules</span>
    </div>
    <b>${cap.n}</b> students waiting: ${cap.girls} girls, ${cap.nonGirls} boys, ${cap.y1} first-year.`;
  if (cap.n > 0) {
    html += `<div class="bind">Binding constraint: <b>${cap.binding.why}</b>.`;
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
  $('#teams-count').textContent = `${list.length} shown of ${state.teams.length}`;
  $('#btn-filter').textContent = 'Show: ' + ({ all: 'all', bad: 'flagged only', ok: 'cleared only' }[filter]);
  if (!list.length) { $('#teams').innerHTML = `<div class="empty">No teams match this filter.</div>`; return; }

  $('#teams').innerHTML = list.map(t => {
    const v = validateTeam(t, R), c = v.c, bad = v.errors.length > 0;
    const lead = t.people[0];
    const rows = t.people.map((p, i) => `
      <div class="row ${p.role === 'Leader' ? 'lead' : ''}">
        <span class="idx">${i + 1}</span>
        <span class="nm" title="${esc(p.name)}">${esc(p.name) || '<i style="color:var(--seal)">unnamed</i>'}</span>
        ${p.role === 'Leader' ? '<span class="crown">Lead</span>' : ''}
        <button class="wbtn ${p.girl ? 'on' : 'off'}" data-act="wtoggle" data-s="${p.id}"
          title="${p.girl ? 'Marked as a girl. Click to unmark.' : 'Click to mark as a girl ( W )'}">W</button>
        <button class="yr y${p.year || 0}" data-act="year" data-s="${p.id}" title="Set year">${p.year ? YEAR_LABEL[p.year] : 'yr ?'}</button>
        <span class="acts">
          ${p.role === 'Leader' ? '' : `<button class="mini" data-act="lead" data-s="${p.id}" title="Make this student the team leader">&#9733;</button>`}
          <button class="mini" data-act="move" data-s="${p.id}" title="Move to another team">&#8646;</button>
          <button class="mini" data-act="pool" data-s="${p.id}" title="Send back to the unassigned pool">&#8595;</button>
        </span>
      </div>`).join('');
    return `<article class="team ${t.draft ? 'draft' : ''} ${bad ? 'bad' : 'ok'}" data-t="${t.id}">
      <div class="stamp ${bad ? 'bad' : 'ok'}">${bad ? 'Flagged' : 'Cleared'}</div>
      <div class="t-head">
        <div class="t-no">${esc(t.no)}</div>
        <div class="t-title">
          <div class="lab">${t.draft ? 'Proposed team' : 'Team leader'}</div>
          <div class="nm">${esc(lead ? lead.name : '-')}</div>
        </div>
        <button class="mini t-x" data-act="dissolve" data-t="${t.id}" title="Dissolve this team and return everyone to the pool">&#10005;</button>
      </div>
      <div class="t-body">${rows}</div>
      <div class="t-foot">
        <div class="compo">
          <span class="n"><b>${c.n}</b> members</span>
          <span class="yr y1">1st <b>${c[1]}</b></span>
          <span class="yr y2">2nd <b>${c[2]}</b></span>
          <span class="yr y3">3rd <b>${c[3]}</b></span>
          <span class="yr y4">4th <b>${c[4]}</b></span>
          ${c[0] ? `<span class="yr y0">? <b>${c[0]}</b></span>` : ''}
          <span class="wtag">W ${c.girls}</span>
        </div>
        ${(v.errors.length || v.warnings.length) ? `<div class="flags">
          ${v.errors.map(e => `<div class="flag">${esc(e)}</div>`).join('')}
          ${v.warnings.map(e => `<div class="flag warn">${esc(e)}</div>`).join('')}
        </div>` : ''}
      </div>
    </article>`;
  }).join('');
}

function renderPool() {
  $('#pool-n').textContent = `${state.pool.length} students`;
  if (!state.pool.length) { $('#pool').innerHTML = `<div class="empty">Everyone has a team.</div>`; return; }
  const groups = [[4, 'Final / 4th year'], [3, '3rd year'], [2, '2nd year'], [1, '1st year'], [0, 'Year not recorded']];
  $('#pool').innerHTML = groups.map(([y, label]) => {
    const g = state.pool.filter(s => (s.year || 0) === y);
    if (!g.length) return '';
    const girls = g.filter(s => s.girl).length;
    return `<div class="pgroup">
      <div class="ph">${label}<span class="n">${g.length}${girls ? ` &middot; ${girls} W` : ''}</span></div>
      <div class="chiprow">${g.map(s => `<span class="chip">
        <button class="chip-nm" data-act="place" data-s="${s.id}" title="${esc(s.branch || '') || 'Click to place on a team'}">${esc(s.name)}</button>
        <button class="wbtn ${s.girl ? 'on' : 'off'}" data-act="wtoggle" data-s="${s.id}"
          title="${s.girl ? 'Marked as a girl. Click to unmark.' : 'Click to mark as a girl ( W )'}">W</button>
        <button class="chip-x" data-act="drop" data-s="${s.id}"
          title="Delete ${esc(s.name)} from the register">&#10005;</button>
      </span>`).join('')}</div>
    </div>`;
  }).join('');
}

function renderIssues() {
  const iss = dataIssues(state);
  $('#iss-n').textContent = iss.length ? `${iss.length} to resolve` : 'none';
  $('#issues').innerHTML = iss.length
    ? iss.map(i => `<div class="iss ${i.lvl === 'warn' ? 'warn' : ''}"><span class="dot"></span><div>${i.txt}<div class="where">${esc(i.where)}</div></div></div>`).join('')
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
  const act_ = b.dataset.act, id = b.dataset.s;
  if (act_ === 'year') return dlgYear(id);
  if (act_ === 'move' || act_ === 'place') return dlgMove(id);
  if (act_ === 'dissolve') return dlgDissolve(b.dataset.t);
  if (act_ === 'wtoggle') {
    const f = findStudent(id); if (!f) return;
    // Marking someone can push their team over rule 3, which is correct: the
    // register should show the truth and flag it, not refuse the correction.
    return act(`/api/students/${id}`, { method: 'PATCH', body: { girl: !f.s.girl } })
      .then(r => {
        if (!r) return;
        const g = findStudent(id);
        const t = g && g.team ? ` Team ${g.team.no} now has ${g.team.people.filter(p => p.girl).length}.` : '';
        toast(`${f.s.name} ${g && g.s.girl ? 'marked as a girl ( W ).' : 'no longer marked as a girl.'}${t}`);
      });
  }
  if (act_ === 'drop') return dlgDrop(id);
  if (act_ === 'lead') return act(`/api/students/${id}/lead`, { method: 'POST' });
  if (act_ === 'pool') return act(`/api/students/${id}/move`, { method: 'POST', body: { to: 'pool' } });
});

/* ---------- dialogs ---------- */

const dlg = $('#dlg');
function openDlg(t, body, foot) { $('#dlg-t').textContent = t; $('#dlg-b').innerHTML = body; $('#dlg-f').innerHTML = foot || ''; dlg.showModal(); }
function closeDlg() { dlg.close(); }
dlg.addEventListener('click', e => { if (e.target === dlg) closeDlg(); });

function dlgYear(id) {
  const f = findStudent(id); if (!f) return;
  openDlg(`Year of study - ${f.s.name}`,
    [1, 2, 3, 4].map(y => `<button class="dest" data-y="${y}"><span class="yr y${y}">${YEAR_LABEL[y]}</span><span>${y === 4 ? 'Fourth / final year' : YEAR_LABEL[y] + ' year'}</span></button>`).join('')
    + `<button class="dest" data-y="0"><span class="yr y0">yr ?</span><span>Not known</span></button>`,
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
      <span class="ok">${why ? '&mdash;' : '&#10003;'}</span>
      <span><b>Team ${esc(t.no)}</b> &nbsp;<span style="color:var(--muted)">${esc(lead)} &middot; ${t.people.length} members</span></span>
      ${why ? `<span class="no">${esc(why)}</span>` : ''}
    </button>`;
  }).join('');
  const allowed = state.teams.filter(t => t !== f.team && !blockedReason(t, s, R)).length;
  openDlg(`Move ${s.name}${s.girl ? ' (W)' : ''} - ${s.year ? YEAR_LABEL[s.year] + ' year' : 'year not recorded'}`,
    `<div style="font-size:11px;color:var(--ink-2);margin-bottom:10px">${allowed} of ${state.teams.length} teams can take this student without breaking a rule.${s.year ? '' : ' <b style="color:var(--seal)">Year is unknown, so rules 1 and 4 cannot be checked.</b>'}</div>`
    + opts
    + (f.team ? `<button class="dest" data-t="pool"><span class="ok">&#8595;</span><span>Unassigned pool</span></button>` : '')
    + `<button class="dest" data-t="delete" style="border-color:var(--seal);color:var(--seal);margin-top:8px"><span class="ok" style="color:var(--seal)">&#10005;</span><span>Delete this record from the register</span><span class="no">for duplicates</span></button>`,
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
    `<div style="font-size:12px;line-height:1.6">
       <b>${esc(s.name)}</b>${s.girl ? ' (W)' : ''} &middot; ${s.year ? YEAR_LABEL[s.year] + ' year' : 'year not recorded'}${s.branch ? ' &middot; ' + esc(s.branch) : ''}
       leaves the register altogether. This is not the same as sending them back to the pool: the record is removed,
       and the only way back is to import the sheet again.
     </div>
     <div style="font-size:11px;color:var(--ink-2);line-height:1.5;margin-top:10px">
       Use this for a duplicate, for someone who appears on a team and in the unassigned sheet at once, or for a student who has withdrawn.
     </div>`,
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
    `<div style="font-size:12px;line-height:1.6">All <b>${t.people.length}</b> members (${esc(t.people.map(p => p.name).join(', '))}) go back to the unassigned pool and Team ${esc(t.no)} leaves the register.</div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn danger" id="do-dis">Dissolve team</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-dis').addEventListener('click', () => { closeDlg(); act(`/api/teams/${tid}`, { method: 'DELETE' }); });
}

/* ---------- toolbar ---------- */

$('#btn-filter').addEventListener('click', () => { filter = { all: 'bad', bad: 'ok', ok: 'all' }[filter]; renderTeams(); });

$('#btn-build').addEventListener('click', () => {
  const R = state.rules, cap = capacity(state.pool, R);
  if (!state.pool.length) return toast('The unassigned pool is empty.');
  openDlg('Auto-build teams from the unassigned pool',
    `<div class="cap" style="margin-bottom:12px">
       <b>${cap.n}</b> students in the pool: ${cap.girls} girls, ${cap.nonGirls} boys, ${cap.y1} first-year.<br>
       At ${R.sizeMin} per team the rules allow at most <b>${cap.max}</b> complete team${cap.max === 1 ? '' : 's'}.
       <div class="bind">Binding constraint: <b>${cap.binding.why}</b>.</div>
     </div>
     <div class="field">
       <label>Number of teams to build</label>
       <input class="inline num" id="nteams" type="number" min="1" max="20" value="${Math.max(1, cap.max)}" style="width:70px">
       <span style="font-size:11px;color:var(--muted)">&nbsp;asking for more than ${cap.max} will produce teams that are flagged</span>
     </div>
     <div style="font-size:11px;color:var(--ink-2);line-height:1.5">
       Each proposed team is anchored on one girl, guaranteed a first-year, and the capped years are spread before the rest are filled.
       Proposals appear on the register with a dashed edge and numbers N1, N2 and so on. They stay drafts until you press Confirm proposals.
     </div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="do-build">Build</button>`);
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
    `<div style="font-size:12px;line-height:1.6">
       <b>${drafts.length}</b> proposed team${drafts.length === 1 ? '' : 's'} (${esc(drafts.map(t => t.no).join(', '))})
       join the register for good and are renumbered after the existing teams.
       Members stay where they are and can still be moved afterwards.
     </div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="do-confirm">Confirm</button>`);
  $('#dlg-f').querySelector('[data-close]').addEventListener('click', closeDlg);
  $('#do-confirm').addEventListener('click', () => { closeDlg(); act('/api/teams/confirm', { method: 'POST' }); });
});

$('#btn-import').addEventListener('click', () => {
  openDlg('Import CSV',
    `<div class="field"><label>Teams sheet</label>
       <textarea class="paste" id="in-teams" placeholder="S.No,Team Leader,Team Member,Year&#10;1,Shourya,Alankrit,2nd Year&#10;,,Ishu ( W ),1st Year"></textarea></div>
     <div class="field"><label>Unassigned students sheet</label>
       <textarea class="paste" id="in-pool" placeholder="S.No,Student Name,Year,Branch/Notes&#10;1,Nisha ( W ),1st Year,CSE + AI"></textarea></div>
     <div style="font-size:11px;color:var(--ink-2);line-height:1.5">
       Paste from the Google Sheet, or drop a .csv file on either box. Mark girls by writing <b>( W )</b> after the name.
       Leave a box empty to keep the sheet that is already loaded. This replaces the stored register for everyone.
     </div>`,
    `<button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="do-import">Replace register</button>`);
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

$('#btn-export').addEventListener('click', () => {
  // The server writes the CSV from what is stored, not from this tab.
  window.location.href = '/api/export.csv';
  toast('CSV exported.');
});

$('#btn-reset').addEventListener('click', () => {
  openDlg('Reset the register',
    `<div style="font-size:12px;line-height:1.6">This discards every move, proposed team and year recorded in the database, and reloads the two sheets exactly as they were shipped. It affects everyone using the register, not just this tab.</div>`,
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
  banner(err.message || 'The register could not be loaded.', 'Retry', () => refresh().catch(() => {}));
});
