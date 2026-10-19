# AGENTS.md

Guidance for AI coding agents working in this repository. Human-oriented setup is in [README.md](README.md).

## Product

Multi-company web app for construction **timesheets and payroll** ("puantaj" in Turkish). Each company (tenant) has its own sites, teams, workers, timesheets and pay rules. First customer data comes from Uzbekistan: salaries in UZS, labels in Uzbek, Russian and Turkish.

- **It is a product, not one company's tool.** Pay rules are configurable, but the app implements the *correct* method, not a customer's spreadsheet mistakes. Example: if a company divides salary by 30 days but /25 working days is correct, the app uses /25.
- **Pay model (decided 2026-10-19): hour-based.**
  - `hourly rate = monthly salary ÷ (working days in that month × normal hours per day)`.
  - Pay = hours × hourly rate × the rate multiplier for that kind of hour. Someone who works every working day at normal hours earns exactly their monthly salary.
  - **Exact hours are paid.** A 4-hour day pays 4 hours. There are no half-day or "counts as a day" thresholds.
  - Hour kinds, each with its own multiplier set in Settings: **normal** (up to the normal hours on a working day), **overtime** (above normal hours on a working day), **rest day** (any hours on a rest weekday, e.g. Sunday), **holiday** (any hours on a public holiday).
  - **Normal hours per day** is a Settings value (e.g. 9).
  - **Absence pay** is set per type (leave, sick, travel/transfer): paid or unpaid. (To confirm: a paid absence day pays normal hours.)
  - **Travel pay** is configured in Settings: fixed amount per day worked per route, or a monthly amount entered by the accountant.
  - Open: how working days per month are determined (proposed: automatic from rest weekdays and the holiday list, with a per-month admin override; awaiting the user's choice), whether settings can differ per site, rounding, and mid-month hire/exit (the hour model already prorates).
  - Uzbek legal minimums (overtime, holiday pay) are deliberately out of scope for now. Don't enforce or assume them until the user raises it.
- UI languages: `uz` (default), `ru`, `tr`, `en`. Every user-facing string goes through i18n in all four files.

## Principles

- **Build it right the first time.** No hacks, workarounds, hard-coded shortcuts or "fix later" code in the product. If the correct solution is bigger than the task, say so and propose it. Don't quietly ship a lesser version.
- **Don't guess decisions that belong to the user.** If the correct behaviour depends on an open product decision (for example pay policy), ask, or make it configurable. Never fill the gap with a placeholder default.
- **Fix root causes, not symptoms.** When something fails, find out why before changing code. Never weaken a test, type or validation to make it pass.
- **One way to do each thing.** Before adding a helper, component or pattern, look for an existing one and reuse or extend it. Two ways of doing the same job is a bug.
- **Payroll must be explainable.** Every amount the app shows must be traceable to its inputs (hours, rate, rule). Results that can't be explained are wrong even if the total looks right.

## Layout

- `packages/payroll`: payroll engine, pure TypeScript with no framework or I/O. All pay logic lives here and is unit-tested.
- `apps/api`: NestJS + Prisma 6 + PostgreSQL 16. Routes are under `/api`.
- `apps/web`: React 19 + Vite. In dev, `/api` is proxied to the API on port 4100.
- `compose.yaml`, `deploy/`: production Docker stack and nginx configs.
- `samples/`: real customer Excel files (git-ignored).

## Commands

Run from the repo root (npm workspaces, Node 22+):

```bash
npm install
npm run db:dev          # local Postgres (PGlite) on 127.0.0.1:5432, keep running
npm run dev:api         # API on 127.0.0.1:4100 (needs apps/api/.env, copy from .env.example)
npm run dev:web         # UI on localhost:5173
npm test                # unit tests (vitest)
npm run typecheck
npm run build
```

Before finishing a change, run `npm test`, `npm run typecheck` and `npm run build`.

**Before any deploy, check the production build in a browser**, not only the dev server: `npm run build -w @puantaj/web && npm run preview -w @puantaj/web` (http://localhost:4173, proxies `/api` to the local API). Load the pages, open a menu, and confirm the console has no errors. The dev server doesn't bundle code, so bundling bugs (e.g. chunk cycles) only show up here. One already took production down.

## Local development quirks

- **No Docker or system PostgreSQL on the dev machine.** The dev DB is PGlite behind a socket server (`scripts/dev-db.mjs`):
  - It accepts **one client at a time.** Stop the API before running Prisma CLI commands. Never keep a second client connected.
  - If a client is killed, the server can keep that connection reserved, and everything then fails with `P1001 Can't reach database server` even though the port is open. Fix: stop `npm run db:dev` and start it again. Data in `.pgdata/` is kept.
  - It has a single database, so `prisma migrate dev` (which needs a shadow DB) fails. To add a migration (from `apps/api`, with the dev DB up to date):
    ```bash
    npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql
    npx prisma migrate deploy
    ```
    Read the generated SQL before applying it.
- The dev machine runs Windows (Git Bash + PowerShell). Its **C: drive is small**, so the npm cache is set to D: in the user-level npm config (not in the repo). Don't put large files on C:.
- Turkish text: `İ`/`ı` break naive case-folding. In `packages/payroll`, cell codes are folded with `toUpperCase()` + `İ → I`. Don't use `toLocaleUpperCase('tr-TR')` for code matching.

## Conventions

- **Tenancy:** every business table has `companyId` (directly or through its parent). Every query must be scoped to the caller's company. Never trust a `companyId` sent by the client.
- **Money:** `Decimal` in the DB (`@db.Decimal(14,2)`). Never use floats for money in payroll code.
- **Dates:** timesheet days are `@db.Date` (no time). Months are 1-based. Weekdays are ISO (1 = Monday, 7 = Sunday).
- Day statuses form a fixed set (`DayStatus` in both `packages/payroll/src/entry.ts` and `schema.prisma`, kept in sync). Customer Excel codes map onto it at import time.
- Schema changes always come with a migration under `apps/api/prisma/migrations`. Never edit an applied migration.
- Match the style of the surrounding code. TypeScript strict mode, 2-space indent, LF line endings.

## UI and design

**Consistency comes first.** Every page must look and behave like the others. A user who learned one screen must already know the next.

**UI stack (decided, don't add alternatives):**

| Need | Use |
|---|---|
| Components | **shadcn/ui** (Radix primitives), source in `apps/web/src/components/ui` |
| Styling | **Tailwind CSS**, using the theme tokens only |
| Forms and validation | **react-hook-form + zod** |
| Lists and tables | **TanStack Table**, wrapped in one shared `DataTable` component |
| Timesheet grid | **AG Grid Community** (only for the grid, styled with our tokens) |
| Icons | **lucide-react** |
| Toasts | **sonner** (the shadcn toast) |
| Date pickers | shadcn Calendar (react-day-picker) with date-fns locales `uz`, `ru`, `tr`, `en` |
| Server data | **TanStack Query** (`useQuery`/`useMutation`) over `lib/api.ts`. Never call `fetch` in a page |
| Routing | **React Router** (`app/router.tsx`). Every page is lazy-loaded and has an entry in `app/nav.ts` |
| Theme | Our own `components/theme-provider.tsx` plus the pre-paint script in `index.html`. Don't add `next-themes` (it breaks under React 19 without SSR) |
| Component tests | Vitest + Testing Library + jsdom (`// @vitest-environment jsdom` per file) |

**Where things live in `apps/web/src`:**
- `app/`: the shell, router, navigation and providers.
- `pages/`: one file per page.
- `components/ui/`: shadcn primitives.
- `components/`: app-level components.
- `lib/`: `api.ts`, `format.ts`, `utils.ts`.
- `hooks/`: `useFormat()` and friends.
- `i18n/`: translations. A test fails if any language is missing a key.

**Shared components that already exist (use them, don't rebuild):** `PageHeader`, `DataTable`, `ConfirmDialog`, `EmptyState`, `ErrorState`, `LoadingState`, `StatusBadge`, `LanguageSwitcher`, `ThemeSwitcher`. Use `useFormat()` for money, numbers and dates.

**Adding shadcn components:** run `npx shadcn@4.22.1 add <name>` in `apps/web`, then check `git diff`. The CLI has written `from "cn"` and installed a stray `cn` npm package before. Imports must be `@/lib/utils`. Primitives here use a 40 px default height (`h-10`), raised from shadcn's 36 px for touch targets; keep that when adding new ones.

shadcn does **not** keep the UI consistent by itself. These rules do:

- **One app shell** for every page: the same header, navigation, page title area, and position for the primary action. No page invents its own layout.
- **Two component layers:**
  - `components/ui/`: shadcn primitives (Button, Input, Dialog…). Add them with the shadcn CLI. Edit them only to change how they behave or look *everywhere*.
  - `components/`: app-level building blocks made from primitives (`PageHeader`, `DataTable`, `MoneyInput`, `ConfirmDialog`, `EmptyState`, `StatusBadge`…).
  - Pages use these two layers only. Pages never restyle a component with ad-hoc classes or build their own version of something that exists. If a component can't do something, extend the component.
- **Design tokens.** Colours, radii, font sizes and shadows are CSS variables in one theme file (shadcn's `:root` / `.dark` variables), exposed to Tailwind. Use semantic classes (`bg-primary`, `text-muted-foreground`, `border-border`). No raw hex colours, no arbitrary values like `w-[37px]` or `text-[#333]`, no Tailwind palette colours (`bg-blue-500`) in app code.
- **One validation system: zod, in both browser and API.** The API validates request bodies with zod too (not class-validator). Schemas used by both sides live in a shared workspace package `packages/schemas` (create it when the first shared schema is needed), so the browser and server never disagree.
- **Same patterns everywhere:**
  - Lists are tables with search, filters and pagination in the same places.
  - Create and edit happen in the same kind of form, with the same button order (primary action on the right) and inline validation messages under the field.
  - Destructive actions always need a confirmation that names what will be affected.
  - Every data view has the same loading, empty and error states.
  - Success and failure feedback uses the same toast.
- **Status colours mean the same thing on every page:** green = ok/worked, red = absent/error, amber = warning/pending, blue = info/leave. Colour is never the only signal. Always add a label or icon.
- **Formatting is centralised.** Dates, numbers and money go through shared formatters that follow the user's language. Money shows the currency with grouped digits (e.g. `7 500 000 soʻm`), with decimals only when present. Never format by hand inside a page.
- **Works on phones.** Foremen enter timesheets on site. Every page must be usable at 360 px wide, with touch targets of at least 40 px. Wide tables scroll inside their container, never the whole page.
- **Accessible:** real `<button>`/`<label>` elements, keyboard navigation (especially in the timesheet grid), visible focus, and contrast of at least WCAG AA.
- **Language-safe layouts:** Russian and Turkish strings are often 30–50% longer than English. Never size UI elements to fit one language's text.
- **Plain wording.** Use the words of construction staff and accountants, not developers. The same thing has the same name on every page and in all four languages.

## Data integrity

- **Locked months are final.** Once a payroll period is locked, its timesheets and amounts can't change. Corrections go into the next open period as adjustments.
- **No silent data loss.** Workers, sites and teams are deactivated, not deleted, once they have timesheet or payroll history.
- **Audit trail:** who changed what and when is recorded for timesheet entries, salaries, adjustments and period locks.
- **Imports never write half a file.** An import validates first, shows every problem row, and then commits all-or-nothing in one transaction.
- **The server is the source of truth.** All validation and payroll calculation run on the server. The UI may repeat checks for convenience but is never trusted.

## Personal data

The sample files and future production data contain passport numbers, PINFLs (personal IDs) and phone numbers.

- Never commit them. `samples/`, `*.xlsx` and `.env` are git-ignored, so don't override that.
- Don't copy real names, PINFLs or passport numbers into code, tests, fixtures, commit messages or docs. Use made-up values in tests.

## Deployment (shared production server)

- SSH alias `enersi-contabo` (key auth, root). The app lives in `/opt/puantaj`, served at https://tahakkuk.en-ersi.uz.
- The server **also runs other live projects** (enersi on :3000 with host Postgres :5432, ixasales in Docker on :8080). Don't modify, restart or reuse their containers, databases, ports or nginx files. This app uses only its own compose project `puantaj`, its own Postgres container, and `127.0.0.1:8090`.
- **Deploys are automatic:** every push to `main` runs `.github/workflows/ci-deploy.yml`:
  1. Tests, typecheck and build, then a browser smoke test (`scripts/smoke.mjs`) of the production build against a real Postgres.
  2. If all pass, the release goes over SSH to `/usr/local/bin/puantaj-deploy` (source: `deploy/puantaj-deploy.sh`). The script builds in a clean folder while the old version keeps running, swaps only if the build succeeds, health-checks, and rolls back by itself if the new version is unhealthy.
  3. The smoke test runs against the live site. If it fails, CI runs `rollback`.
  - Pull requests run step 1 only.
  - Pushing to `main` therefore deploys to production. Push only when the user has agreed to the change going live.
- The GitHub deploy key (secret `DEPLOY_SSH_KEY`; private key also at `~/.ssh/puantaj_github_actions` on the dev machine) is locked in `/root/.ssh/authorized_keys` with `restrict,command="/usr/local/bin/puantaj-deploy"`. It can only run `deploy <sha>`, `rollback` or `status`, with no shell or forwarding. Never loosen this.
- Manual operations, from the dev machine (normal `enersi-contabo` alias): `ssh enersi-contabo puantaj-deploy status`, `ssh enersi-contabo puantaj-deploy rollback`, and a manual deploy with `git archive HEAD | ssh enersi-contabo puantaj-deploy deploy $(git rev-parse HEAD)`. Never unpack over `/opt/puantaj` by hand: files deleted from the repo would stay behind.
- After changing `deploy/puantaj-deploy.sh`, install it on the server yourself (it isn't deployed automatically): `scp deploy/puantaj-deploy.sh enersi-contabo:/tmp/ && ssh enersi-contabo 'bash -n /tmp/puantaj-deploy.sh && install -m 0755 /tmp/puantaj-deploy.sh /usr/local/bin/puantaj-deploy'`.
- Rollback restores code, not data: database migrations are not undone. Check before rolling back across a migration.
- nginx: our site file is `/etc/nginx/sites-available/tahakkuk.en-ersi.uz`. Always run `nginx -t` before `systemctl reload nginx`, because one bad file takes down every site on the server.
- Secrets live only in `/opt/puantaj/.env` on the server. Never print or commit them.
- Production changes (deploys, nginx, certificates, DB operations) need the user's go-ahead.
