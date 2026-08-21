import 'dotenv/config';
import { app } from './app.js';
import { ensureSchema } from './repo.js';
import { authRequired } from './auth.js';

const PORT = Number(process.env.PORT) || 3000;

// The register starts empty. Coordinators fill it from the Import box or by
// adding students one at a time; nothing is shipped in.
await ensureSchema();

const server = app.listen(PORT, () => {
  console.log(`SIH 2026 Team Register on http://localhost:${PORT}`);
  console.log(authRequired() ? '[auth] passcode required for changes' : '[auth] open, ADMIN_PASSWORD is not set');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
