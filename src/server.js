import 'dotenv/config';
import { app } from './app.js';
import { ensureSchema, isEmpty, replaceRegister } from './repo.js';
import { parseTeams, parsePool } from '../shared/domain.js';
import { readFile } from 'node:fs/promises';
import { authRequired } from './auth.js';

const PORT = Number(process.env.PORT) || 3000;

// First boot against an empty database loads the two shipped sheets, so a fresh
// deploy shows the real register rather than an empty page.
await ensureSchema();
if (await isEmpty()) {
  await replaceRegister({
    teams: parseTeams(await readFile(new URL('../data/teams.csv', import.meta.url), 'utf8')),
    pool: parsePool(await readFile(new URL('../data/pool.csv', import.meta.url), 'utf8'))
  }, 'seed');
  console.log('[boot] empty database seeded from the shipped sheets');
}

const server = app.listen(PORT, () => {
  console.log(`SIH 2026 Team Register on http://localhost:${PORT}`);
  console.log(authRequired() ? '[auth] passcode required for changes' : '[auth] open, ADMIN_PASSWORD is not set');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
