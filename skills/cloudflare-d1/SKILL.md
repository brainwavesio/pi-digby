---
name: cloudflare-d1
description: Query Brainwaves Cloudflare D1 databases using the organisation-managed read-only runtime credential. Use this to resolve application user IDs to names and email domains for customer reporting.
---

# Cloudflare D1

Use the bundled read-only query helper. It discovers the database ID by its exact name and never prints credentials.

```bash
/data/skills/cloudflare-d1/query.sh brainwaves_db \
  'SELECT id, email, name FROM "user" ORDER BY email'
```

The first argument is the database name and the second is one read-only SQL statement. The helper rejects multiple statements and anything that does not begin with `SELECT` or `EXPLAIN`.

For token-cost reporting, join Langfuse `userId` values to the D1 `user.id` column. Group customer usage by the organisation implied by email domain, folding all Assembly-owned domains into one Assembly line. Keep Brainwaves staff and obvious test users on a separate internal/test line. State the date range and whether it is a complete month.

Do not print, inspect, or persist `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`.
