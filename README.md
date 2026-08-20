# SIH 2026 RBCET - Team Register

Registration and Participant Management for the RBCET internal round of Smart India Hackathon 2026.

This is the server-backed version of `team-registry.html`.
The interface is unchanged.
What changed is where the register lives: it is a Postgres database instead of one browser's `localStorage`, so several coordinators see the same register and a change made on one laptop is visible on the others.

## What it does

- Holds 18 teams and the unassigned pool, and checks every team against the four rules laid down by the Director and the HOD.
- Explains why a team is flagged, and why a particular student cannot join a particular team.
- Shows the binding constraint on new teams live, and recomputes it whenever a rule is changed.
- Proposes teams from the unassigned pool, anchored on one girl and guaranteed a first-year.
- Imports either sheet as pasted CSV or a dropped file, and exports a CSV it can read back without loss.
- Takes a late walk-in straight onto the register with **Add student**, without re-importing a sheet.

The rules themselves are documented in `../TEAM-REGISTER.md`, which still describes what the register found in the current data.

## Reading the interface

Each team card carries five pips, one per rule, in the order size, 1, 2, 3, 4.
A red pip is a broken rule, so twenty cards can be scanned without reading a word.
Hovering a pip names the rule and what went wrong.

The coloured spine down the left edge of a card repeats the same thing at a glance: green cleared, red flagged, blue proposed.
Year of study is shown as a four-step scale from light to dark rather than four unrelated colours, and rose is used for nothing except the `W` marker.

The interface follows the system light or dark setting, and the button in the top bar overrides it per browser.

## Running it locally

Node 20 or newer, and a Postgres database.

```bash
pnpm install
docker compose up -d                 # or point DATABASE_URL at any Postgres
cp .env.example .env                 # the default URL matches docker compose
pnpm db:setup                        # creates the schema and loads the two sheets
pnpm dev                             # http://localhost:3000
```

`pnpm db:setup` seeds only an empty database.
`pnpm db:reset` reloads the shipped sheets over whatever is there.

```bash
pnpm test        # 23 tests: the rules engine, and the API against a real database
```

The API tests reset the register, so point `DATABASE_URL` at a scratch database when running them.
They skip themselves entirely when `DATABASE_URL` is unset, and they sign themselves in when `ADMIN_PASSWORD` is set, so the suite passes either way.

## Who can change the register

Leave `ADMIN_PASSWORD` unset and the register is fully open.
That is right on a laptop and wrong on a public URL.

Set it, and reading stays open to everyone while every change asks for the passcode once per browser.
Signed-out visitors get a read-only register: the move arrows, the delete controls and the rule inputs are gone, and the server refuses the write even if someone calls the API directly.

Set `SESSION_SECRET` as well if you want sessions to survive a redeploy.

## How it is put together

```
shared/domain.js   the rules engine, CSV parsing, capacity, auto-builder
src/schema.sql     teams, students, rules, audit_log
src/repo.js        every read and every mutation, each in one transaction
src/app.js         the HTTP API and the static frontend
src/server.js      listen (EC2, Render, Docker, local)
api/index.js       the same app as a Vercel function
public/            the interface
```

`shared/domain.js` is imported by the server and served to the browser unchanged.
A rule is therefore defined once: the browser uses it to grey out an impossible destination, and the server uses the same function to refuse the move if someone tries anyway.
A stale tab cannot push a team over a rule.

Every mutation runs inside a transaction that takes one advisory lock, so two coordinators clicking at the same moment queue rather than interleave.
Pool membership is `team_id IS NULL`, so a student is always in exactly one place.
Seat 0 is the leader, and seats close up when anyone leaves.
`audit_log` records every change, readable at `/api/audit`.

### API

| Method | Path | |
|---|---|---|
| GET | `/api/state` | the whole register |
| GET | `/api/export.csv` | CSV written from what is stored |
| GET | `/api/audit` | recent changes |
| GET | `/api/health` | liveness, including the database |
| POST | `/api/students` | add one student straight into the pool |
| PATCH | `/api/students/:id` | year, girl marker, name |
| POST | `/api/students/:id/move` | `{to: teamId \| "pool" \| "delete"}` |
| POST | `/api/students/:id/lead` | make this student the leader |
| DELETE | `/api/teams/:id` | dissolve, members return to the pool |
| POST | `/api/teams/autobuild` | `{count}`, replaces any previous proposals |
| POST | `/api/teams/confirm` | proposals join the register and are renumbered |
| PUT | `/api/rules` | the five editable numbers |
| POST | `/api/import` | `{teamsCsv, poolCsv}`, either may be empty |
| POST | `/api/reset` | reload the shipped sheets |
| POST / DELETE | `/api/session` | sign in, sign out |

Everything that changes the register needs the passcode when one is set.

## Deploying

The register runs on one EC2 instance, with Postgres in a container beside it.
Everything for that lives in `deploy/`.

For a register that holds about 130 rows and is used by a handful of coordinators during one event, a managed database is more infrastructure than the problem needs.
The tradeoff is that backups are yours rather than a managed service's, which `deploy/backup.sh` handles.

### What the stack is

`deploy/docker-compose.prod.yml` runs three containers:

| | |
|---|---|
| `db` | Postgres 16, on a named volume, publishing **no ports at all** |
| `app` | this app, reachable only from inside the compose network |
| `caddy` | the only container bound to the host, on 80 and 443, with its own certificate |

The database is unreachable from the internet by construction rather than by firewall rule.
The only way in is through Caddy.

### You need a domain

Caddy gets a certificate automatically, but Let's Encrypt will not issue one for an `ec2-*.compute.amazonaws.com` address.
Point a real name at the instance's elastic IP first.

This is not optional decoration.
The coordinator passcode is sent over this connection, and without TLS it travels in plaintext.

### Setting it up

Security group: allow 80 and 443 from anywhere, and 22 from your own address only.
Nothing else needs to be open, and 5432 in particular must not be.

Use `t3.small` rather than `t3.micro`.
The app, Postgres and Caddy all fit in 1GB, but building the Node image on 1GB is where it falls over.
If you are set on `t3.micro`, add swap before building.

```bash
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user   # log out and back in

# Amazon Linux 2023 ships the engine but not the Compose v2 plugin.
docker compose version || {
  sudo mkdir -p /usr/local/lib/docker/cli-plugins
  sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m) \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
}

git clone <your repo> && cd team-registry

cp deploy/.env.example deploy/.env
openssl rand -base64 24            # POSTGRES_PASSWORD
openssl rand -hex 32               # SESSION_SECRET
$EDITOR deploy/.env                # and set DOMAIN and ADMIN_PASSWORD

docker compose -f deploy/docker-compose.prod.yml up -d --build
```

The app creates its schema and loads the two sheets on first boot, so the register is populated as soon as the containers are healthy.

```bash
docker compose -f deploy/docker-compose.prod.yml ps
curl https://your-domain/api/health
```

Both `db` and `app` should read `healthy`.

### Backups

There is no managed service taking snapshots, so install the timer:

```bash
sudo cp deploy/team-register-backup.{service,timer} /etc/systemd/system/
sudo systemctl enable --now team-register-backup.timer
```

It dumps to `deploy/backups/` twice a day and keeps 14 days.
A dump under 1KB is treated as a failure rather than reported as a backup.

To restore:

```bash
gunzip -c deploy/backups/sih2026-YYYYmmdd-HHMMSS.sql.gz \
  | docker compose -f deploy/docker-compose.prod.yml exec -T db psql -U sih -d sih2026
```

This procedure has been tested against a damaged register, not just written down.
Copy the dumps off the instance periodically, since a backup on the same disk as the database is not a backup.

### Updating

```bash
git pull
docker compose -f deploy/docker-compose.prod.yml up -d --build
```

The database volume is untouched by a rebuild, so the register survives.
Take a backup first anyway.

### Other hosts

The app is not tied to any of this.
`src/server.js` is a plain Node process that needs `DATABASE_URL`, so it runs on Render, Fly, or a bare VPS with no changes.

`api/index.js` and `vercel.json` are set up for Vercel against a Neon database.
That path is configured but has not been deployed and verified, and it needs `pnpm db:setup` run against Neon before the first deploy, because a serverless function has no boot step to seed from.

## Where the data comes from

`data/teams.csv` and `data/pool.csv` are the two sheets as originally shipped, and are what Reset restores.
Replace them to change what a fresh database is seeded with.
To load newer sheets into a running register, use Import rather than editing these files.
