---
name: test-guard
description: Stabilise tests that fail only sometimes. Use when a test passes on retry, fails in CI but not locally, depends on timing, ordering or shared state, or is quarantined as flaky.
---

1. Run the test many times in a loop and record the failure rate.
2. Look for time, randomness, test order and shared state.
3. Fix the cause; never add a bare retry or sleep.
