# test-fixtures

Reusable internal test helpers for live package tests.

What is real here today:

- durable temp-directory fixture tracking for workspace-style tests
- shared cleanup utilities used by package tests under `packages/execution-adapters` and `packages/snapshot-engine`

This package is intentionally small and only contains fixtures that are actively used by the repo's real test suite.
