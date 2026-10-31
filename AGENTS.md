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
  - **Absence pay** is set per type (leave, sick, travel/transfer) in Settings: paid or unpaid, plus **hours paid per absence day** (pay = those hours × hourly rate). All three are **paid by default**. Default for **sick: 8 hours**. Default for leave and travel/transfer: the normal hours per day, following it if it changes (confirmed 2026-10-20). Absences recorded on rest days or holidays are **not paid** (nobody was due at work), so a full month never pays more than the salary.
  - **Travel pay** is configured in Settings: fixed amount per day worked per route, or a monthly amount entered by the accountant. "Per day worked" counts **working days only**: rest days and holidays worked don't earn travel pay.
  - **Working days per month (decided: option D):** calculated automatically from the rest weekdays and the holiday list, with a per-month override (by owner, admin or accountant). The app shows the calculated and overridden values side by side and records who changed them (audit trail). The app ships Uzbekistan's fixed-date public holidays per year. Moving holidays (Ramazon Hayit, Qurbon Hayit) and company days off are entered by an admin, and the app warns when a year's holidays are missing. Government day-off swaps are entered as both halves: the extra day off, and the rest weekday that becomes a working day (holiday kind `WORKING_DAY`).
  - **Final pay is rounded to the nearest 1000 soʻm** (halves up), a company Settings value. The difference shows as its own rounding line.
    - **Rounded once, on the amount to pay out (decided 2026-10-24):** earned pay plus bonuses minus advances and deductions. The parts of a split month are not rounded on their own. The step is company-wide (in the company default rules); site rule sets have no rounding step of their own.
  - **Per-site settings:** a site may have its own rule set (rest weekdays and pay settings) that overrides the company default. Working-days overrides are per rule set.
    - **Split by placement (decided 2026-10-23):** pay rules follow the worker's placement (employment site), not the site where hours were entered. A worker whose placements in one month fall under different rule sets is paid in parts: the days of each placement under that placement's rules, at an hourly rate from that rule set's working days and normal hours. Each part is its own block on the payslip, so a full month split this way may not add up to exactly the salary.
  - **Shifts (decided 2026-10-24):** a company may define shifts, each with a name and its own **normal hours per day** (e.g. day 8, night 10), set by an owner or admin in Settings. Shifts are optional: a worker without a shift uses the normal hours of their rule set.
    - A shift belongs to the worker **from a day**, until a newer one, so it can change in the middle of a month.
    - **Who:** owner, admin and accountant assign shifts for all workers, and timekeepers for workers placed on their sites, also for many workers at once ("night shift from day X"). Accountants and timekeepers only add a new shift from a day; correcting one is owner or admin only, audited with old and new values (like absence periods). A shift carries no pay amounts, so timekeepers see their workers' shifts.
    - The worker's shift on a day replaces the rule set's normal hours everywhere for that day: the hourly rate, the overtime threshold, leave and travel/transfer absence hours that follow normal hours, and the "Normal hours" start of a day. Working days and every other rule still come from the rule set.
    - The hourly rate is `monthly salary ÷ (working days × the shift's normal hours)`, so a full month on any one shift at its normal hours pays exactly the salary.
    - A shift change mid-month splits the month into parts, like a placement split, each part its own block on the payslip. All parts share the rule set's working days, so a full month split only by shift still adds up to exactly the salary.
    - **A night shift that crosses midnight counts on the day it ends**: Saturday 19:00 to Sunday 06:00 is Sunday's hours, paid as rest-day hours if Sunday is a rest weekday.
    - There is no night premium.
    - **Shifts come only from the app.** The Excel import reads hours and never creates or changes shifts. If the file has a shift column, the import checks it against the worker's shifts in the app, and a mismatch is a problem row.
    - **Monthly totals are entered per part:** when a shift change splits a placement-month, the accountant enters hours for each part (its days are shown). The app never divides one total between parts.
  - Open: mid-month hire/exit (the hour model already prorates).
  - The overtime, rest-day and holiday multipliers have **no default**: the admin enters them when setting up the company.
  - Uzbek legal minimums (overtime, holiday pay) are deliberately out of scope for now. Don't enforce or assume them until the user raises it.
- **Mobile app (decided 2026-10-20): a native app for foremen and timekeepers**, alongside the web app. Workers don't use it and don't have accounts. Timesheet entry must **work offline** on site and sync later. Photo and GPS check-in at the site will come later. It isn't built yet, but every API built from now on must already work for it:
  - **Auth:** the API accepts the same server-side session either as the browser cookie or as a bearer token (`Authorization` header) for the app. The token is random and only its hash is stored. Each app session has a device name and can be revoked. The same-site Origin check applies to cookie requests only.
  - **Offline-safe writes:** the client may create record IDs (UUIDs). Writes that the app syncs are idempotent, so a retry never creates duplicates. They also carry a version, so stale data from a phone is rejected instead of silently overwriting newer data. Syncing into a locked month is rejected with a clear error code.
  - **Old app versions keep working:** API changes are backward compatible. When that's impossible, the API reports a minimum supported app version and older apps ask the user to update.
  - Code meant for both web and mobile (schemas, payroll, translations) lives in shared packages, not inside `apps/web`.
  - **Framework: React Native with Expo** (decided 2026-10-20). It reuses the shared TypeScript packages. The app will live in `apps/mobile`.
- **Modules (decided 2026-10-20):** one app for everyone, with modules enabled per company. There is no separate build.
  - Two modules: **Payroll**, which every company has, and **Timesheet**, which is optional. A timesheet-only company isn't offered.
  - A company's modules come from its **plan** (see Platform admin). Only the platform admin assigns plans, so only they turn the Timesheet module on or off.
  - The API refuses routes of a disabled module with a stable error code. Every route declares its module through a guard, as with `@Roles`. Navigation, Settings and the mobile app show only enabled modules.
  - **Where hours come from** in a company without the Timesheet module: an **Excel import of the daily grid**, or **monthly totals per worker** entered by the accountant (normal, overtime, rest-day and holiday hours, plus absence days). Both feed the same payroll engine. Every pay result shows which source its hours came from.
  - **One source per worker and month (decided 2026-10-23).** Hours for a worker-month come from exactly one source (daily entries, Excel import or monthly totals), so nothing is counted twice. When a second source is entered for a worker-month that already has one, the app warns and asks which to keep; it never adds sources together. (So far the app refuses the second source, and an Excel import reports it as a problem row.)
  - **Modules only switch features on or off.** They don't restrict anything else: a company with the Timesheet module can also use Excel import and monthly totals.
  - Turning the Timesheet module on or off takes effect from the **next month**, with the plan change (see Plans), so one month never mixes sources because of the switch. Hours of a month are entered with the modules of that month: after the module is turned off, the grid stays available for earlier months that had it until they are locked.
- **Platform admin (decided 2026-10-22):** the product operator can do anything on the platform. Every action is audited.
  - **Companies:** create, edit name, currency and time zone, activate and deactivate, assign a plan, record payments.
  - **Users:** list all accounts, create accounts, edit name, phone and email, activate and deactivate, reset passwords (a one-time temporary password), grant or remove platform admin, and add people to companies or change their role there. A platform admin can't deactivate themselves or remove their own platform admin flag, so there is always one left. Users are never deleted.
  - **Log in as a user ("impersonation"):** full access to whatever that user can do, for at most **1 hour**, never extended. Every action is audited under both names (the user, and the platform admin acting as them). The app shows a banner with an "End" button. Not allowed: impersonating another platform admin or a deactivated account, and, while impersonating, changing the user's password, managing their sessions, or accepting or declining invitations for them.
  - **Plans:** a plan has a name, a monthly price in soʻm, a **limit of active workers**, and the modules it includes. There are no limits on users or sites. A plan can be archived (not offered to new companies) but stays on companies that have it. Once a company has had a plan, its price, worker limit and modules are fixed (`plan.inUse`), because a change would reach months that already started; only its name can change. New terms go into a new plan that companies move to.
    - **Active workers** in a month = workers with a placement overlapping that month. Adding a worker or a placement that would take that month over the limit is refused (`plan.workerLimitReached`), checked against the plan of the month the placement starts, or of the current month if it started earlier. Existing workers, timesheets and payroll are never blocked.
  - **Subscriptions:** each company is **paid through a month** (decided 2026-10-24: "paid through October" covers the whole of October), since customers pay per calendar month. Payments are made outside the app (bank transfer, invoice). The platform admin records each payment (amount, date paid, new paid-through month, note); records are only ever added. A free extension (e.g. a trial) is a payment of 0.
    - After the last day of the paid-through month there is a **14-day grace period**: owners see a warning banner. After it the company is **read-only**: everyone can view and export, but no change is accepted (`subscription.expired`) until the platform admin records a payment.
    - **Plan changes start on the 1st of the next month, with no exceptions (decided 2026-10-24):** price, worker limit and modules all change together, so each month has exactly one plan. Customers pay per calendar month. The change is stored as pending until then (a plan history per month); choosing the current plan again cancels it. A new company starts on its plan from the 1st of the month it is created in.
    - Companies created before plans existed have no plan: no limits, no expiry, Payroll only. The platform admin's company list marks them so a plan can be assigned; like any change, it starts on the 1st of the next month.

- **Roles (decided 2026-10-20, partly open, see `docs/ideas.md` idea 3):**
  - **Accountant: add and view only, never edit or delete.** Corrections are made by adding a new record (e.g. a new salary from a date, an adjustment), never by changing an old one.
    - **Salaries (decided 2026-10-23):** a salary belongs to the worker (not to a placement, so moving sites keeps it) and starts **from a month**, covering that whole month and later ones until a newer salary. One salary per worker-month. Owner, admin and accountant add salaries; project managers only view them on their sites.
    - The accountant adds salaries, adjustments, monthly travel amounts and working-day overrides, and can lock a month.
  - **Locking a month:** owner, admin or accountant. **Unlocking: owner only**, with a required reason and an audit record.
  - **Timekeepers and foremen never see salaries or pay amounts.** The API doesn't send these fields to them at all; hiding them in the UI isn't enough.
  - **Only an owner or admin can change pay rules in Settings.**
  - **New role: project manager.** Code `PROJECT_MANAGER`. Names: uz *Loyiha boshligʻi*, ru *Начальник проекта*, tr *Şantiye şefi*, en *Project manager*.
    - Works only on the sites they are assigned to. An owner or admin assigns them.
    - Manages workers and teams on those sites, and assigns foremen and timekeepers there.
    - Can't create sites: only an owner or admin can.
    - Sees salaries (for now).
    - **Approves hours but doesn't enter them.** They're one of the roles a company can pick as approver.
- **Hour entry (decided 2026-10-20): one flow, configured per company** in Settings. There are no separate flows per company.
  - Settings choose which roles may enter hours (timekeeper, foreman, or both), whether entries need approval, and who approves. **Default for a new company: the timekeeper enters hours, and approval is off.**
  - Who can see and enter what is scoped: a foreman to their own team(s), a timekeeper to their assigned site(s). Admins and owners see everything. The API enforces this, like company scoping.
  - Each entry records who entered it and, when approval is on, who approved it. Payroll uses only approved hours when approval is on.
  - **Only an admin or owner can change hours after approval**, and the change is audited. A locked month can't be changed by anyone.
  - **The daily grid (decided 2026-10-24):**
    - Owners and admins can always enter hours, whatever roles Settings choose.
    - Any day of an open month can be entered, including days that haven't come yet (hours as well as absences).
    - Hours are typed as a number; absences are typed with the **company's own codes** (`TimesheetCode`, the same list the Excel import uses), so everyone in a company types the same letters whatever their language. There is no code for a day off: rest days and holidays come from the calendar.
  - **A worker can work on two or more sites or teams on the same day**, with the hours split between them. Hours are stored per worker, day and site/team. Two people editing the same entry are protected by the version check (see Mobile app).
    - Normal hours per day apply to the worker's **total** for the day, across all sites. Overtime above that is charged to the **site entered later**: the entry created last for that worker and day, by creation time, not by edit time.
    - **Travel pay counts a split day once**, not once per site, at the route amount of the **site entered later** (same rule as overtime).
  - **Starting a day's timesheet (decided 2026-10-23):** whoever creates the timesheet for a day picks how it starts:
    - **Blank:** nothing filled in.
    - **Normal hours:** every worker gets the normal hours per day.
    - **Yesterday:** copies hours and statuses per worker and site/team from the last working day before the day being started (e.g. Saturday or Friday on a Monday), only for workers still placed there. Working days follow the site's rule set (rest weekdays and holidays, including `WORKING_DAY` swaps).
    - Absence periods win in every mode: a worker on sick leave shows sick, never normal or copied hours.
    - Starting a day is only a pre-fill. Nothing counts until the creator saves it, and approval (when on) still applies.
  - **Entry deadline: reminders only, never a block.** Late entries are always accepted. For now reminders go to foremen and timekeepers, each only for their own teams or sites, as mobile push notifications. Each company sets its own deadline in Settings. The default is 10:00 the next morning, in the company's local time.
- **Absence periods (decided 2026-10-23):** an absence is entered once per worker as a period (type, first and last day, note or document number such as the sick note number) instead of on every day.
  - Types: leave, sick, travel/transfer, and unexcused absence (`ABSENT`, unpaid).
  - **Who:** every role, each only for the workers it already sees (foreman: own teams; timekeeper and project manager: own sites; owner, admin and accountant: all). When hour approval is on, periods need approval by the same approvers as hours.
  - **Changing a period: owner or admin only**, audited with old and new values. The accountant stays add-only and asks an owner or admin to correct a period.
  - **Periods fill days; payroll reads days.** Payroll never reads periods directly, so there is one pay path and "one source per worker-month" holds.
    - Each day filled from a period records which period it came from, so the payslip can explain it (e.g. "sick 23.10–31.10").
    - Rest days and holidays inside a period stay rest days and holidays (not paid as absence).
    - A day that already has hours or another status is never overwritten: the app shows the conflict and someone decides. The same applies when hours are entered later on a day a period covers.
    - Days in a locked month are not changed; a period reaching into one is refused for those days.
    - Editing a period updates only the days it filled that nobody has changed since; anything else shows as a conflict.
  - In a company without the Timesheet module, periods count the absence days for monthly totals, still one source per worker-month.
  - **Worker history:** one timeline per worker in date order (hire, placements and moves, salary changes, absence periods, adjustments, exit). It is a view over existing records, not a new store.
  - Later, not now: leave balance, attaching a photo of the sick note.
- **Departments (decided 2026-10-28):** a company's own tree of departments (e.g. HSE, QA/QC, IT), with sub-departments to any depth. Departments are company-wide, not per site.
  - **A company setting turns departments on.** When on, every placement must have a department; when off, departments are hidden. Existing companies keep working unchanged.
  - A worker can be placed in a department at **any level** (e.g. the HSE manager in HSE itself, inspectors in a sub-department).
  - **A brigade (team) belongs to one department**, as well as to its site. A placement in a brigade takes the brigade's department, so the two never disagree. Brigades stay optional.
  - **Who:** only an owner or admin creates, renames, moves or deactivates departments (like sites). Project managers create brigades in a department on their sites. A department is deactivated, never deleted, once used, and can't be moved under its own sub-department.
  - Moving to another department is a new placement from a date, like a site move. Departments don't affect pay: pay rules still follow the site's rule set.
  - Workers, payroll results and exports can be filtered and totalled by department, and a department's totals include its sub-departments.
  - Department names are company data, not translated. Access is not scoped by department (yet).
- **Excel import (decided 2026-10-29):** a customer's monthly Excel sheet is imported for a chosen month in two steps, both from the same file: **workers**, then **hours** (the daily grid). Each step checks the whole file first and shows every problem row; it writes nothing while any problem is left, then writes everything in one transaction.
  - **Workers are recognised by their employee number** (e.g. the file's SICIL column), a worker field unique per company. Workers added in the app may have none; such a worker can't be matched until it is filled in.
  - **Columns are mapped once and saved.** The app guesses each column from the header row, the user confirms or corrects the guess, and the mapping is saved per company (by header text) for next month. Day columns are the header cells `1`…`31`. Values that stand for a fixed choice (employment type) are mapped the same way.
  - **Workers step (owner or admin):** adds the workers whose employee number is new, with their personal data, position, employment type, placement (site, department, hire date, exit date) and salary from the import month (a blank or 0 salary adds none). The import never creates sites, departments or shifts: a name the app doesn't have is a problem row, and someone adds it in the app.
    - **Exit date before the hire date (decided 2026-10-29):** the exit date is trusted. The worker is placed from their first day in the month with hours or a code (other than a "not employed" one) until the exit date, and the preview notes that the hire date was ignored. Without such a day it stays a problem row.
    - **No exit date, but a "not employed" code (e.g. CIKIS, fired) from some day on (decided 2026-10-29):** the exit date is the day before the first such code after the worker started, with a note. For a worker already in the app it shows as a difference (exit date), set on their page.
    - Everything else stays strict (invalid phones, a missing site or hire date, hours outside the employment dates are problem rows): the customer's file is corrected, not guessed at. Workers already in the app are not changed; where the file differs (site, department, exit date, salary), the preview says so, and the change is made in the app.
  - **Blank cells while employed (decided 2026-10-30):** a company setting, saved with its column mapping and chosen on the import page: a **problem row** (the default, as before), or an **unexcused absence** (`ABSENT`, unpaid), listed as a note with its days. With absences, a month can be imported before it ends; importing the complete file later replaces them.
  - **Hours step (owner, admin or accountant):** each day cell is read with the company's codes (`TimesheetCode`). Problem rows: an unknown worker or code, a blank cell while employed (unless the company reads blanks as absences), hours or a code while not employed, a worker twice in the file, a shift column that differs from the worker's shift (AGENTS.md: Shifts), and a worker-month whose hours already come from daily entries or monthly totals (one source per worker-month). A locked month refuses the import.
  - **Imported hours are daily entries marked with their import**, so payroll reads them like any day and every pay result shows "Excel import" as its source.
  - **Editing imported hours (decided 2026-10-31):** an owner or admin may change, add or clear days of an imported worker-month in the daily grid, audited with old and new values. Everyone else corrects by importing again. The days stay part of the import, so the month keeps one source, and they are recorded as changed by hand (`ImportedDayEdit`, cleared days too): the grid and the payslip show it.
  - **Importing a month again replaces** the earlier import's hours of the worker-months in the new file, audited with old and new values, so the file has the last word. Days changed by hand that the file says differently are listed in the preview and the confirmation before they are overwritten. Worker-months not in the new file keep what they had.
- **Adjustments (decided 2026-10-24):** money added to or taken from a worker's pay for one month: **bonus** (+), **advance** (−, money already handed over) and **deduction** (−). The amount is always entered as positive; the type gives the sign.
  - An adjustment belongs to the **worker-month**, not to a placement (like salaries). On a split payslip it shows once, in its own block after the parts. The monthly travel amount is separate and stays per placement, since it follows the route.
  - **Who:** owner, admin and accountant add them; project managers only view them on their sites; timekeepers and foremen never see them. Only in an open month.
  - **Mistakes are cancelled, never edited or deleted.** Whoever may add an adjustment may cancel one in an open month: the cancel is its own audited record with a required reason. The cancelled adjustment stays visible, marked cancelled, and no longer counts.
  - **Pay out below zero** (advances and deductions above what was earned) is shown with a warning that the worker owes it. The month can still be locked. Nothing carries to the next month by itself; the accountant adds a deduction there if wanted.
- UI languages: `uz` (default), `ru`, `tr`, `en`. Every user-facing string goes through i18n in all four files.

## Principles

- **Build it right the first time.** No hacks, workarounds, hard-coded shortcuts or "fix later" code in the product. If the correct solution is bigger than the task, say so and propose it. Don't quietly ship a lesser version.
- **Don't guess decisions that belong to the user.** If the correct behaviour depends on an open product decision (for example pay policy), ask, or make it configurable. Never fill the gap with a placeholder default.
- **Fix root causes, not symptoms.** When something fails, find out why before changing code. Never weaken a test, type or validation to make it pass.
- **One way to do each thing.** Before adding a helper, component or pattern, look for an existing one and reuse or extend it. Two ways of doing the same job is a bug.
- **Payroll must be explainable.** Every amount the app shows must be traceable to its inputs (hours, rate, rule). Results that can't be explained are wrong even if the total looks right.

## Layout

- `packages/payroll`: payroll engine, pure TypeScript with no framework or I/O. All pay logic lives here and is unit-tested.
- `packages/schemas`: zod validation schemas shared by the web app and the API (ESM + CommonJS build, `sideEffects: false`).
- `apps/api`: NestJS + Prisma 6 + PostgreSQL 16. Routes are under `/api`. API tests live in `apps/api/test`.
- `apps/web`: React 19 + Vite. In dev, `/api` is proxied to the API on port 4100.
- `compose.yaml`, `deploy/`: production Docker stack and nginx configs.
- `samples/`: real customer Excel files (git-ignored).

## Commands

Run from the repo root (npm workspaces, Node 22+):

```bash
npm install
npm run build:packages                      # build shared packages (others import their dist)
npx -w @puantaj/api prisma generate
npm run db:dev                              # local Postgres (PGlite) on 127.0.0.1:5432, keep running
npx -w @puantaj/api prisma migrate deploy
npm run build -w @puantaj/api && npm run seed:dev -w @puantaj/api   # demo accounts, see below
npm run dev:api                             # API on 127.0.0.1:4100 (needs apps/api/.env, copy from .env.example)
npm run dev:web                             # UI on localhost:5173
npm test                                    # all tests; API tests start their own in-memory DB
npm run typecheck
npm run build
```

Demo accounts from `seed:dev` (local only, refuses to run in production): `platform@`, `owner@`, `admin@`, `accountant@`, `pm@`, `timekeeper@`, `foreman@` and `other-owner@demo.puantaj.test`, all with `DEV_SEED_PASSWORD` from `apps/api/.env`. Re-running resets them.

Before finishing a change, run `npm test`, `npm run typecheck` and `npm run build`.

**Before any deploy, check the production build in a browser**, not only the dev server: `npm run build -w @puantaj/web && npm run preview -w @puantaj/web` (http://localhost:4173, proxies `/api` to the local API). Load the pages, open a menu, and confirm the console has no errors. The dev server doesn't bundle code, so bundling bugs (e.g. chunk cycles) only show up here. One already took production down.

## Local development quirks

- **No Docker or system PostgreSQL on the dev machine.** The dev DB is PGlite behind a socket server (`scripts/dev-db.mjs`):
  - All clients share **one PGlite session**. That's why the dev `DATABASE_URL` has `pgbouncer=true`: Prisma then uses unnamed prepared statements. Without it, clients collide ("prepared statement \"s0\" already exists"), and a killed client's statements break every later client. Keep that flag in dev and never use it in production.
  - Several clients may connect at once (API, Prisma CLI, tests): `maxConnections` is raised in `scripts/pglite-server.mjs`, which both the dev DB and the local API tests use.
  - Out of the box, PGlite answers a failed query (e.g. a unique violation) in a way that makes Prisma report "Server has closed the connection" (P1017) instead of the real error. `scripts/pglite-server.mjs` corrects this, so tests can assert real Prisma codes (P2002, P2003). Always start PGlite through it. Session-level state (e.g. `SET`) is shared between clients, so don't rely on it in code.
  - It has a single database, so `prisma migrate dev` (which needs a shadow DB) fails. Create a migration by diffing the committed schema against the edited one (from `apps/api`):
    ```bash
    git show HEAD:apps/api/prisma/schema.prisma > /tmp/schema.before.prisma
    npx prisma migrate diff --from-schema-datamodel /tmp/schema.before.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql
    npx prisma migrate deploy
    ```
    Read the generated SQL before applying it, and add anything Prisma can't express (e.g. CHECK constraints) by hand.
  - Windows locks Prisma's engine file while any process uses it. Stop the dev API before `prisma generate`.
- The dev machine runs Windows (Git Bash + PowerShell). Its **C: drive is small**, so the npm cache is set to D: in the user-level npm config (not in the repo). Don't put large files on C:.
- Windows on this machine sometimes briefly locks files (writes fail with `UNKNOWN`, Node reports `.env: not found`). Retry the step; if a scripted write keeps failing, use a direct file edit.
- Vite's dev and preview proxies must keep the browser's Host header (`changeOrigin: false`, in `vite.config.ts`), like nginx in production. Otherwise the API's same-site check rejects every login.
- Turkish text: `İ`/`ı` break naive case-folding. In `packages/payroll`, cell codes are folded with `toUpperCase()` + `İ → I`. Don't use `toLocaleUpperCase('tr-TR')` for code matching.

## Conventions

- **Tenancy:** every business table has `companyId` (directly or through its parent). Every query must be scoped to the caller's company. Never trust a `companyId` sent by the client. A child that points to another company-scoped row carries `companyId` too and uses a composite foreign key `(parentId, companyId) → (id, companyId)`, so the database refuses rows that mix two companies.
- **Auth (API):**
  - Server-side sessions: the client holds a random token and the DB stores only its hash. The browser gets it as an httpOnly cookie (`POST /auth/login`), the mobile app as a bearer token (`POST /auth/token` with a device name). A token works only the way it was issued (`Session.kind`). Users list and revoke their own sessions (`/auth/sessions`). Passwords use Argon2id.
  - Every route needs a login unless marked `@Public()` (never reads the session) or `@OptionalAuth()` (runs either way).
  - Access is declared with `@Roles(...)` and `@PlatformAdminOnly()`. Every route with `@Roles` also declares its module with `@ForModule('PAYROLL' | 'TIMESHEET')`; the guard fails loudly (500) if it's missing and refuses a disabled module with `module.disabled`.
  - Site and team scope: project managers and timekeepers work on the sites in `MemberSite`, foremen on the teams in `MemberTeam`. Who sees and manages what is decided only in `apps/api/src/organisation/access.ts`. Combine its filters with `AND`, never by spreading.
  - Company routes take `@CompanyAuth() auth` and scope every query by `auth.company.id`.
  - Roles: OWNER, ADMIN, ACCOUNTANT, PROJECT_MANAGER, TIMEKEEPER, FOREMAN. Changing a member's role clears their site and team assignments. Platform admin is a separate user flag for the product operator, whose routes are under `/platform` with `@PlatformAdminOnly()`.
  - Impersonation lives on the platform admin's own session (`Session.impersonatedUserId`). While it runs, `auth.user` is the impersonated user and `auth.impersonator` the platform admin. Routes that only the real person may use are marked `@NotWhileImpersonating()`. Audit entries take `auth` and record both users, so audit calls never pass `actorUserId` themselves for logged-in actions.
  - Temporary passwords are returned once to the admin and never stored or logged in readable form. `mustChangePassword` locks the account to me/logout/change-password.
  - A company admin can reset only passwords of accounts that belong to their company alone.
  - Data-changing cookie requests are checked for same-site Origin (`SameOriginGuard`); bearer requests are not.
  - Salaries live in `Salary`, not in the worker's placement (`Assignment`), and are only ever added. Placements are shown to timekeepers and foremen; salaries and workers' personal data never are.
- **Errors:** throw the helpers in `apps/api/src/common/api-error.ts` with a stable `code` (e.g. `forbidden('member.lastOwner')`). Never send user-facing text from the API. The web shows `errors.<code>`. Validation errors carry per-field translation keys (`validation.*`) from the shared schemas. A web test fails if any code or key used in the API, schemas or web is missing from the translations.
- **Validation:** request bodies go through `new ZodPipe(schema)` with a schema from `@puantaj/schemas`, and forms use the same schema via `zodResolver`. Schemas export `…Input` (form) and plain (validated) types.
- **Audit:** every change to company data records an `AuditLog` row through `AuditService.record(entry, tx)`, inside the same transaction as the change. Never put passwords or tokens in audit data.
- **Tests:** API tests run the real app (`startApp()` in `test/helpers.ts`) against a real database. Every new company-scoped endpoint needs a tenant-isolation test (company A can't read or change company B's data). When a test passes on the first try, break the code on purpose once to prove the test can fail.
- **Money:** `Decimal` in the DB (`@db.Decimal(14,2)`). Never use floats for money in payroll code. `packages/payroll` takes money, hours and multipliers as decimal strings (Prisma's `Decimal#toString()`), computes in BigInt hundredths (`decimal.ts`) and rounds each pay line once.
- **Dates:** timesheet days are `@db.Date` (no time). Months are 1-based. Weekdays are ISO (1 = Monday, 7 = Sunday).
- Day statuses form a fixed set (`DayStatus` in both `packages/payroll/src/entry.ts` and `schema.prisma`, kept in sync). Customer Excel codes map onto it at import time through each company's own code list (`TimesheetCode`). A **blank cell** means "not employed" before hire or after exit, and is a problem row while the worker is employed (missing data is never guessed), unless the company chose to read such blanks as unexcused absences (AGENTS.md: Excel import).
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

**Shared components that already exist (use them, don't rebuild):** `PageHeader`, `DataTable` (with `searchText` for extra searchable fields), `ConfirmDialog`, `EmptyState`, `ErrorState`, `LoadingState`, `StatusBadge`, `RequireAccess`, `Field`/`FormActions`/`FormError` (`components/form.tsx`), `RoleSelect`, `TemporaryPasswordDialog`, `UserMenu`, `LanguageSwitcher`, `ThemeSwitcher`. Use `useFormat()` for money, numbers and dates.

**Page patterns:**
- A page starts with `PageHeader`. Role-restricted content goes inside `<RequireAccess allowed={…}>{(me) => …}</RequireAccess>`, and the API enforces the same rule.
- Forms use `useForm` + `zodResolver(sharedSchema)` + `Field`. On a failed mutation, call `applyFieldErrors(error, form.setError)` and fall back to `errorMessage(t, error)` in `FormError` or a toast.
- `useMe()` is the logged-in user (null when logged out). After login, logout or a company switch, call `useResetSession()`, and on logout navigate away *before* resetting.
- **Formatting:** Uzbek is formatted by hand in `lib/format.ts` (`19.10.2026`, `7 500 000 soʻm`, `sentabr, 2026`) because many browsers ship without Uzbek locale data. Never format Uzbek with Intl directly. Calendar days ("YYYY-MM-DD") are shown as that day; timestamps in the viewer's time zone.

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

- **Locked months are final.** Once a payroll period is locked, its timesheets and amounts can't change. Corrections go into the next open period as adjustments. The one exception: an **owner can unlock a month**, giving a reason that is stored in the audit log. Unlocking is rare and never silent.
  - **A month can be locked only after it has ended** (in the company's time zone) **and when every worker in it can be paid** (decided 2026-10-23). Missing salaries, hours or pay rules are fixed first, so a locked month is always complete.
  - **Every lock saves a snapshot** of the month's results. When the month is locked again, the app shows the differences from the previous lock, per worker.
  - Differences are **not** carried into the next month automatically. The accountant decides and adds adjustments if needed.
- **No silent data loss.** Workers, sites and teams are deactivated, not deleted, once they have timesheet or payroll history. Relations use `onDelete: NoAction` (not `Cascade`/`SetNull`, and not `Restrict`, whose Postgres error Prisma doesn't map to P2003), so a stray delete fails instead of taking history with it. Only `Session` cascades from `User`.
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
- First platform admin (once per server; prints a temporary password, so the user should run it in their own terminal, not through an agent): `ssh enersi-contabo "cd /opt/puantaj && docker compose exec api node dist/cli/create-platform-admin.js --name 'Full Name' --phone '+998…'"`.
- Production changes (deploys, nginx, certificates, DB operations) need the user's go-ahead.
