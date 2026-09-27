---
name: test-guard
description: Helps with tests.
---

1. Run the test many times in a loop and record the failure rate.
2. Look for time, randomness, test order and shared state.
3. Fix the cause; never add a bare retry or sleep.
