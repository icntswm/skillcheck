---
name: db-migrations
description: Write safe PostgreSQL schema migrations. Use when adding or dropping a column, table or index, changing a column type, or backfilling data on a live database without locking writes.
---

1. Prefer additive changes; split destructive ones into several releases.
2. Create indexes CONCURRENTLY, add NOT NULL through a validated CHECK first.
3. Backfill in batches.
