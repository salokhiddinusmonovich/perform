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
