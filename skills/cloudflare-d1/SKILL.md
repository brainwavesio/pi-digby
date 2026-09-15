---
name: cloudflare-d1
description: Query Brainwaves Cloudflare D1 databases using the organisation-managed read-only runtime credential. Use this to resolve application user IDs to names and email domains for customer reporting.
---

# Cloudflare D1

Use the bundled user-directory helper. It discovers the production database by its exact name, runs a fixed read-only query, and never prints credentials.

```bash
/data/skills/cloudflare-d1/users.sh
```

For token-cost reporting, join Langfuse `userId` values to the D1 `user.id` column. Group customer usage by the organisation implied by email domain, folding all Assembly-owned domains into one Assembly line. Keep Brainwaves staff and obvious test users on a separate internal/test line. State the date range and whether it is a complete month.

Do not print, inspect, or persist `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID`.
