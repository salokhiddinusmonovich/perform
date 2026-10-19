# Puantaj

Timesheet (puantaj) and payroll web app for construction companies. Multi-company: every company has its own sites, teams, workers, timesheets and pay rules.

## Layout

| Path | What |
|---|---|
| `packages/payroll` | Pure TypeScript payroll engine: month calendar, timesheet codes, hour summaries. No framework, fully unit-tested. |
| `apps/api` | NestJS REST API + Prisma (PostgreSQL 16). Routes under `/api`. |
| `apps/web` | React + Vite UI, languages: uz / ru / tr / en. |
| `compose.yaml`, `deploy/` | Production Docker stack and nginx configs. |
| `samples/` | Real customer Excel files used as reference. **Git-ignored: they contain personal data.** |

## Local development

Requires Node 22+. No Docker or PostgreSQL install is needed locally.

```bash
npm install
npm run db:dev        # terminal 1: local PostgreSQL (PGlite) on 127.0.0.1:5432
cp apps/api/.env.example apps/api/.env
npx -w @puantaj/api prisma migrate deploy
npm run dev:api       # terminal 2: API on http://127.0.0.1:4100
npm run dev:web       # terminal 3: UI on http://localhost:5173 (proxies /api)
```

Notes on the dev database (PGlite):
- It serves **one client at a time**. Stop the API before running Prisma CLI commands.
- It has a single database, so `prisma migrate dev` (which needs a shadow database) does not work. Create migrations with:
  ```bash
  npx -w @puantaj/api prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <real postgres url> --script
  ```
  or ask for a scratch Postgres. Production uses a real PostgreSQL 16 container.

Checks:

```bash
npm test         # unit tests
npm run typecheck
npm run build
```

## Production

Runs on the shared server in `/opt/puantaj` next to other projects:

- `docker compose up -d --build` starts `db` (Postgres 16), `api` (runs migrations on start) and `web` (nginx serving the UI and proxying `/api`).
- Only `127.0.0.1:8090` is published. The host nginx proxies the domain to it (`deploy/host-nginx.conf.example`) and certbot issues TLS.
- Secrets live in `/opt/puantaj/.env` (see `.env.example`).
