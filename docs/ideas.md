# Ideas and open topics

Ideas from the product owner that are **not decided yet**. Don't build anything from this file. When an idea is decided, move it as a rule into [AGENTS.md](../AGENTS.md) with the decision date and remove it here.

Each entry has: the idea as stated, the agent's comments, and the open questions.

---

## 1. Mobile app (2026-10-20): decided

Moved to [AGENTS.md](../AGENTS.md) (Product → Mobile app): a native app for foremen and timekeepers, offline entry, photo/GPS check-in later, and what the API must support from now on. The framework is React Native with Expo.

---

## 2. Who enters hours (2026-10-20): mostly decided

Decided parts moved to [AGENTS.md](../AGENTS.md) (Product → Hour entry): one flow with per-company settings, timekeeper enters by default, only admin or owner changes approved hours, split days across sites are allowed, and deadlines only send reminders.

**Still open:**

1. **How do the companies in `samples/` fill timesheets today?** Who fills them in, and does anyone check them? This shows whether the defaults fit real use.

---

## 3. Roles (2026-10-20): decided

Decided parts moved to [AGENTS.md](../AGENTS.md) (Product → Roles): what the accountant can do, who locks months, who sees salaries, who changes pay rules, and the new project manager role.

---

## 4. Payroll-only companies (2026-10-20): decided

Moved to [AGENTS.md](../AGENTS.md) (Product → Modules), including two sources in one worker-month (decided 2026-10-23: one source per worker-month).

---

## 5. One customer with several companies (2026-10-23): open

**Idea:** one customer can own more than one company. How should the app model this: founder → companies, company → subcompanies, or holding → companies?

**What exists today:** one login can already belong to several companies (`Membership`) and switch between them. Each company has its own plan, subscription, workers, pay rules and locked months. What's missing is anything that ties the companies together: one bill, one place to see all of them, people who automatically get access to every company in the group, and reports across companies.

**What others do:**
- **Separate companies under one account** (Xero, QuickBooks): each company is fully separate, one login switches between them, billing per company or per account. Nothing is shared except the login and the bill.
- **One account with several legal entities** (Gusto, Deel, Rippling, Odoo, and 1C with several "организации" in one database, which customers in Uzbekistan know well): one account, entities inside it, shared lists and settings, reports across entities.

**Agent's comments:**
- **The company stays the legal employer and the tenant.** Payroll, salaries, locked months and (later) tax reports belong to one legal entity. Our whole data model is scoped by `companyId` and enforced by composite foreign keys, which is right and shouldn't be loosened.
- **Recommended: a thin group above companies** (working name *Group*, uz *Guruh* / ru *Группа компаний* / tr *Şirketler grubu*). A group has a name, its companies, group members (e.g. *group owner*, who gets owner access to every company in the group, and maybe *group viewer*), and possibly the subscription. Companies stay exactly as they are, so nothing in tenancy changes.
- **Not company → subcompanies.** A tree of companies inside companies makes every access check recursive and doesn't match reality: a subsidiary is its own legal entity anyway. One flat level (group → companies) covers holdings.
- **Not founder → companies.** A founder is a person, and people change: a company is sold, a second partner joins. Tie the companies to a group, and make the founder a member of it.
- **The same person in two companies** stays two worker records (one per company; PINFL is unique per company). Moving a worker between companies is an exit in one and a hire in the other, which is also what the law sees. A group-level view could show both records as one person.

**Open questions:**
1. **Billing:** one plan and payment for the whole group, or each company pays separately? If one plan, is the active-worker limit shared across the group?
2. **Access:** is a group owner who sees every company enough, or are more group roles needed (e.g. a group accountant)?
3. **Reports across companies:** which ones are needed (total payroll cost, headcount, hours per site)? Read-only only?
4. **Shared settings:** should a new company in a group copy pay rules, timesheet codes and holidays from another company, or follow them (inherit)? Copying is simpler and safer.
5. **Who creates companies in a group:** only the platform admin (as now), or the group owner too (which then needs a billing rule)?
6. **Does a real customer need this now?** Which one, and how many companies do they have?

---

## 6. Worker history and absence periods (2026-10-23): decided

Moved to [AGENTS.md](../AGENTS.md) (Product → Absence periods, and Hour entry → Starting a day's timesheet).
