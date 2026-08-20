import crypto from 'node:crypto';

// Optional gate. With ADMIN_PASSWORD unset the register is fully open, which is
// what you want on a laptop. Set it before putting the app on a public URL and
// reading stays open to everyone while every change needs the passcode.
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || (PASSWORD ? `sih2026:${PASSWORD}` : crypto.randomBytes(32).toString('hex'));
const COOKIE = 'sih_session';
const TTL_MS = 12 * 60 * 60 * 1000;

export const authRequired = () => Boolean(PASSWORD);

const sign = payload => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function mint() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, mac] = token.split('.');
  const want = sign(payload);
  if (mac.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function isSignedIn(req) {
  return !authRequired() || verify(readCookie(req, COOKIE));
}

// Constant-time passcode check, so a wrong guess reveals nothing by timing.
export function checkPassword(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function setSessionCookie(res) {
  res.append('Set-Cookie',
    `${COOKIE}=${mint()}; Path=/; Max-Age=${TTL_MS / 1000}; HttpOnly; SameSite=Lax` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : ''));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

// Guards every route that changes the register.
export function requireAdmin(req, res, next) {
  if (isSignedIn(req)) return next();
  res.status(401).json({ error: 'Sign in with the coordinator passcode to change the register.', needsAuth: true });
}
