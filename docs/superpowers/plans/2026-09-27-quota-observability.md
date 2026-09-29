# Quota Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Expose complete, trustworthy quota observations and history through a reusable local service, MCP and CLI.

**Architecture:** Keep source adapters and legacy rendering, add versioned observations and a single writer coordinator. Readers access persisted state; refresh uses local IPC and never bypasses cooldown.

**Tech Stack:** TypeScript, Node 20+, existing MCP SDK, Zod, Vitest, node:fs/net/zlib/child_process.

**Spec:** docs/superpowers/specs/2026-09-27-quota-observability-design.md

## Global Constraints

- No task attribution, token regression, forecast or live quota load tests.
- Preserve untracked user files and old month history; all tests use temporary data directories.
- Unknown values remain unknown; percent-only values never become absolute counts in the new model.
- Default raw page size 100, maximum 1000; includeRaw maximum 20.
- UTC half-open query intervals; no interpolation or cross-account/unit/reset aggregation.
- Default collection interval five minutes; gap threshold fifteen minutes; persistent retry deadlines.
- Existing legacy tools keep their output shapes; refresh deliberately becomes asynchronous.

## Review Focus

1. Duplicate upstream old/new buckets and display name changes: normalize fixtures without identity churn or duplicate totals (Task 1).
2. Crash/restart during rate limiting and concurrent refreshes: persisted scheduling and real IPC concurrency test (Task 3).
3. Missing observations, unknown cycles and account change: quality and aggregate isolation tests (Task 4).
4. Secret keys nested in arrays and raw payloads: recursive redaction and disk round-trip tests (Tasks 1–2).
5. Partial writes, expired raw payload and pagination while new data arrives: storage/query integration tests (Tasks 2, 4).

## Task 1: Observation model and adapters

Files: create src/observation.ts, src/claude-usage.ts, tests/observation.test.ts; modify src/types.ts and source collectors.
Interfaces: `normalizeSnapshot(snapshot: QuotaSnapshot): Observation`; `parseClaudeUsage(raw: unknown, observedAt: string): QuotaSnapshot`; `redact(value: unknown): unknown`; Observation carries schemaVersion, observationId, source, accountKey, observedAt, limits, extensions, raw metadata.

- [x] Write fixtures testing scoped Fable, known duplicate weekly/session entries, unknown numeric objects, dollar buckets, null preservation, label rename and array reordering. Representative assertion:
  ```ts
  expect(observation.limits.find(x => x.label.includes('Fable'))?.measurement).toEqual({ utilizationPct: 92 });
  expect(JSON.stringify(redact({ nested: [{ accessToken: 'secret' }] }))).not.toContain('secret');
  ```
- [x] Run `npx vitest run tests/observation.test.ts`; expect missing exports/behavior to fail.
- [x] Implement explicit Claude mappings and stable identity. Keep source response extensions separate; use percent-only adapters for existing collectors, preserve available source raw data and mapping metadata.
  ```ts
  const measurement = { utilizationPct: upstream.percent };
  const accountKey = snapshot.accountKey ?? 'unknown';
  ```
- [x] Run targeted collector tests and typecheck; expect all pass.

## Task 2: Durable store and compatibility

Files: create src/store.ts, tests/store.test.ts; modify src/history.ts.
Interfaces: `ObservationStore(homeDir, options)` exposes append/read/readRaw/readState/writeState/maintain; legacy history projects observations to QuotaSnapshot.

- [x] Add tests for daily JSONL, raw redaction, atomic state replacement, corrupted tail count, compression, retention and old-month reads.
  ```ts
  store.append(observation, { accessToken: 'secret', foo: null });
  expect(store.readRaw(observation).status).toBe('available');
  expect(store.read(from, to).observations).toHaveLength(1);
  ```
- [x] Run `npx vitest run tests/store.test.ts`; expect failure before implementation.
- [x] Implement private directories/files, day shards, raw retention, gzip closed days and diagnostics; atomic state via write-temp/rename. Never rewrite old month shards.
- [x] Run store and existing history tests; expect both pass.

## Task 3: Coordinator and daemon

Files: create src/coordinator.ts, src/ipc.ts, src/daemon.ts, src/collectors/index.ts, tests/coordinator.test.ts, tests/ipc.test.ts; modify src/config.ts and src/types.ts.
Interfaces: `Coordinator.refresh(sources?, manual?)`, `Coordinator.tick()`, `Coordinator.status()`, `startIpc(home, handler)`, `requestIpc(home, request)`.

- [x] Test parallel refresh coalescing, persisted Retry-After, auth suspension/manual retry, source isolation, persistence failures and duplicate service startup.
  ```ts
  expect(coordinator.refresh(['claude-code'])[0].status).toBe('accepted');
  expect(coordinator.refresh(['claude-code'])[0].status).toBe('coalesced');
  ```
- [x] Run coordinator/IPC tests; expect failure.
- [x] Implement a single local service and durable per-source deadlines, in-flight tracking, cancellable collectors, classified errors and heartbeat. Stale endpoint recovery must not unlink a live server socket. Query clients never invoke collectors.
- [x] Run tests plus restart and duplicate-start integration; expect pass without real credentials or remote requests.

## Task 4: Query API and integrations

Files: create src/query.ts, src/cli.ts, src/service-install.ts, tests/query.test.ts, tests/service.test.ts; modify src/server.ts, scripts/export-json.ts, scripts/report.ts, scripts/smoke.ts, macos/App.swift, package.json, README.md.
Interfaces: `getQuotas(home, filters)`, `getHistory(home, input)`, `getStatus(home, sources?)`, `getLegacyQuotas(home, sources?)`; CLI commands quotas/history/status/refresh/daemon/install-service/report/export.

- [x] Test raw pagination with frozen record bound, filters, malformed cursors, missing intervals, reset/account/unit partitions, raw payload size status, CLI validation and launchd plist escaping.
  ```ts
  expect(getHistory(home, { from, to, pageSize: 1 }).nextCursor).toBeDefined();
  expect(getQuotas(home).sources[0].freshness).toBe('stale');
  ```
- [x] Run new tests; expect failure.
- [x] Implement structured queries and aggregation, Zod input validation, shared MCP/CLI routes and legacy adapters. Launchd installer writes explicit executable paths and private logs. Menu bar invokes installed CLI without repository-specific paths and polls cache; manual refresh submits request.
- [x] Run all tests, typecheck, build and CLI help/status in a temporary home; build Swift if available. Expect green suite and no network traffic.

## Task 5: Final review and delivery

- [x] Ask agy to review only the implementation diff and new files, checking the spec and tests, with no writes or live calls.
- [x] Reproduce important findings with tests, fix, rerun suite/typecheck/build.
- [x] Update README with install/start/query and privacy/retention contracts, record measured validation results and any platform limits.
- [x] Keep unrelated files untouched; present result and local runtime installation status accurately.

## Execution ledger

- Baseline: 134 tests passed, 12 files. Existing untracked files inventoried before changes.
- Authorization: user approved design and explicitly requested agy review followed by implementation; proceed inline without another approval round.
- Ruling: work in existing checkout, preserve user files; no branch/commit/publish operation required for delivery.
- Pre-flight: Task 2 consumes Observation from Task 1; Task 3 consumes store state/append from Task 2; Task 4 consumes all three. Interface names above are authoritative.

### Implementation evidence (2026-09-28)

- Task 1: complete. Added versioned observations, Claude scoped/unknown/dollar data, explicit aliases, Codex native IDs, Gemini native/HTML adapters, Antigravity derived provenance and cancellation.
- Task 2: complete. Private daily records and raw data, sequence watermark, atomic scheduling state, one-byte append-tail inspection, asynchronous streaming gzip, retention and legacy month compatibility.
- Task 3: complete. Single local IPC service, persisted cooldown and preflight leases, source isolation, authentication suspension, cancellation and fail-closed storage errors. Startup after a repaired storage fault preserves deadlines and retries durable writes.
- Task 4: complete. New MCP/CLI queries, pagination, reset/account/unit separation, freshness, coverage and gaps, installer and client migration. Packaging allow-list excludes pre-existing scratch/debug files.
- Task 5: complete. Initial agy review REQUEST_CHANGES addressed; follow-up verification CONFIRMED (conversation 89fc4a36-c841-4e06-a4be-53de7c2ee5ac).
- Validation: 172 tests passed across 20 files; TypeScript typecheck and build passed; npm pack dry-run passed (34 files). Real CLI/IPC integration reads a new scoped-limit observation into the HTML report and verifies duplicate daemon rejection and offline status after stop. Tests never contact live quota providers.
- Native UI validation: App.swift compiled successfully with installed MacOSX26.5.sdk and target arm64-apple-macosx15.0, output /private/tmp/quotacheck-menu-test. Default MacOSX27 SDK lacks SwiftUIMacros.StateMacro and fails for both HEAD baseline and modified source; no toolchain installation or source workaround was needed. launchd plist passed plutil -lint.
- Runtime deployment: no actual user launchd service installed, no real credential/remote quota smoke test, no commits or publication performed.
- Ruling: Claude interrupted requests retain a one-hour conservative lease; other sources use max(collection interval, timeout). This protects the known escalating endpoint without unnecessarily freezing every provider.
- Ruling: report compatibility uses `readHistory`, which now combines daily observations and legacy month shards. The review allegation that reports omit daily records is refuted by the real CLI report test.

### Deployment and merge validation (2026-09-28)

- User subsequently authorized local service deployment. Installed `com.quotacheck.poller`, updated/launched the menu bar binary and created the user-local CLI wrapper. Confirmed running after restart; Claude, Codex and Antigravity collected successfully. Gemini requires a fresh web login.
- Live deployment exposed the exact Gemini “Not signed in” error wording; added a failing regression test, fixed authentication classification, rebuilt and restarted the daemon. Full suite now passes 173 tests across 20 files.
- User authorized merging into main. Pre-merge full suite (173), typecheck, build and diff whitespace checks passed. Existing unrelated untracked files are excluded from staging; merge is local, without a remote push.
