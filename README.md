# Puantaj

Timesheet (puantaj) and payroll web app for construction companies. Multi-company: every company has its own sites, teams, workers, timesheets and pay rules.

## Layout

| Path | What |
|---|---|
| `packages/payroll` | Pure TypeScript payroll engine: month calendar, timesheet codes, hour summaries. No framework, fully unit-tested. |
| `packages/schemas` | Validation rules shared by the web app and the API (zod). |
| `apps/api` | NestJS REST API + Prisma (PostgreSQL 16). Routes under `/api`. Login, companies, users, audit log. |
| `apps/web` | React + Vite UI, languages: uz / ru / tr / en. |
| `compose.yaml`, `deploy/` | Production Docker stack, nginx configs, server deploy script. |
| `samples/` | Real customer Excel files used as reference. **Git-ignored: they contain personal data.** |

## Local development

Requires Node 22+. No Docker or PostgreSQL install is needed locally.

```bash
npm install
npm run build:packages
npx -w @puantaj/api prisma generate
cp apps/api/.env.example apps/api/.env
npm run db:dev        # terminal 1: local PostgreSQL (PGlite) on 127.0.0.1:5432
npx -w @puantaj/api prisma migrate deploy
npm run build -w @puantaj/api && npm run seed:dev -w @puantaj/api   # demo accounts
npm run dev:api       # terminal 2: API on http://127.0.0.1:4100
npm run dev:web       # terminal 3: UI on http://localhost:5173 (proxies /api)
```

Log in with a demo account such as `owner@demo.puantaj.test` or `platform@demo.puantaj.test`, using the `DEV_SEED_PASSWORD` from `apps/api/.env`.

The dev database (PGlite) has a single database, so `prisma migrate dev` doesn't work. See "Local development quirks" in [AGENTS.md](AGENTS.md) for how to create migrations. Production uses a real PostgreSQL 16 container.

Checks:

```bash
npm test         # all tests (API tests start their own in-memory database)
npm run typecheck
npm run build
```

## Production

Runs on the shared server in `/opt/puantaj` next to other projects. Every push to `main` is tested and deployed automatically (`.github/workflows/ci-deploy.yml`):

- `db` (Postgres 16), `api` (runs migrations on start) and `web` (nginx serving the UI and proxying `/api`) run with Docker Compose.
- Only `127.0.0.1:8090` is published. The host nginx proxies the domain to it (`deploy/host-nginx.conf.example`) and certbot issues TLS.
- Secrets live in `/opt/puantaj/.env` (see `.env.example`).
- The first platform admin is created once with `create-platform-admin` (see AGENTS.md → Deployment).
