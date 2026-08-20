import pg from 'pg';

// A year is a SMALLINT and a count is a BIGINT; both are small enough for a
// JavaScript number, so read them as numbers rather than strings.
pg.types.setTypeParser(pg.types.builtins.INT8, v => parseInt(v, 10));

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and point it at a Postgres database.');
}

// Neon and most managed Postgres require TLS but present a certificate this
// client cannot chain to a local root, so verification is relaxed for them.
// A plain local database needs no TLS at all.
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(DATABASE_URL);
const wantsNoSSL = /[?&]sslmode=disable/.test(DATABASE_URL);

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: (isLocal || wantsNoSSL) ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', err => console.error('[db] idle client error:', err.message));

export const query = (text, params) => pool.query(text, params);

// Runs fn inside a transaction, rolling back on any throw.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
