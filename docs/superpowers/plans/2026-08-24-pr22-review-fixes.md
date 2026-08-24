# PR 22 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every unresolved PR 22 review thread without changing the public protocol beyond the security and correctness behavior requested by the reviewers.

**Architecture:** Keep fixes at the existing boundaries. The web client will merge request headers with `Headers`; core will insert chat lines inside closed fences; server routes will enforce account/document/folder ownership and perform document deletion in one transaction; collaboration will apply suggestion pairs at their recorded location. The Makefile will add the already documented core test suite to `check`.

**Tech Stack:** TypeScript, Express, better-sqlite3, Vitest, pnpm, Make.

**Spec:** PR 22 unresolved inline review threads for commit `6d39f82d3fcb6badb4ef968e1f5766be5b61f390`.

## Global Constraints

- Preserve REST/MCP/CLI parity and existing response shapes unless a review requires an authorization status change.
- Use the existing `resolveAccess`, `requireRole`, and account helpers; do not add dependencies.
- Keep SQLite foreign keys enabled and make document deletion atomic.
- Add a regression test for every behavior change before production code.
- Do not commit, push, merge, or resolve GitHub threads automatically.

---

### Task 1: Preserve web request headers

**Files:**

- Modify: `web/src/api.ts:15-22`

**Interfaces:**

- Consumes: `RequestInit.headers` and `extraHeaders` passed by `writeDoc`.
- Produces: A fetch request whose headers contain both the caller's options and helper extras, with extras taking precedence case-insensitively.

- [ ] **Step 1: Define the failing behavior**

  `writeDoc` supplies `if-match` through `opts.headers` and `x-share-key` through `extraHeaders`; the request helper must send both headers.

- [ ] **Step 2: Implement the minimal fix**

  Replace the plain object spread with `new Headers(opts.headers)`, set every extra header on that instance, preserve the JSON content type behavior, and pass the `Headers` instance to `fetch`.

- [ ] **Step 3: Run the web typecheck**

  Run: `rtk pnpm --filter @can-bang/web typecheck`

  Expected: PASS with the `Headers` instance accepted as `RequestInit.headers`.

### Task 2: Insert chat messages inside closed fences

**Files:**

- Modify: `core/src/markdown.ts:140-147`
- Test: `core/test/markdown.test.ts:53-59`

**Interfaces:**

- Consumes: `Fence.end` from `findFence`.
- Produces: `appendFenceLine` output that `parseChat` can read when the fence has a closing line.

- [ ] **Step 1: Write the failing test**

  Extend the chat test so it asserts the appended line is returned by `parseChat(updated)`.

  ```ts
  expect(parseChat(updated).some((line) => line.name === 'claude')).toBe(true)
  ```

- [ ] **Step 2: Run the core test and confirm the expected failure**

  Run: `rtk pnpm --filter @can-bang/core exec vitest run core/test/markdown.test.ts`

  Expected: FAIL because the message is currently inserted after the closing fence.

- [ ] **Step 3: Implement the minimal fix**

  Insert at `fence.end` when that line is the closing ``````, otherwise insert after the final content line so unterminated fences retain their current behavior.

- [ ] **Step 4: Run the core test and confirm it passes**

  Run: `rtk pnpm --filter @can-bang/core exec vitest run core/test/markdown.test.ts`

  Expected: PASS.

### Task 3: Secure and safely delete documents

**Files:**

- Modify: `server/src/routes/docs.ts:256-317`
- Test: `server/test/docs.test.ts:141-151` and a new document deletion regression case.

**Interfaces:**

- Consumes: `resolveAccess` and the document child tables declared in `server/src/db.ts`.
- Produces: `DELETE /api/docs/:id` that removes or detaches all dependent rows before the parent and `POST /api/docs/:id/duplicate` that requires `access.role` in addition to an account identity.

- [ ] **Step 1: Write failing tests**

  Add a deletion test that creates an anonymous document, deletes it with its edit key, and asserts a 200 response plus zero rows in `docs` and `revisions`; the current route returns 500 because the initial revision remains.

  Extend the duplicate test with a second account attempting to duplicate a private document owned by the first account and assert 403.

- [ ] **Step 2: Run the focused server tests and confirm the expected failures**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/docs.test.ts`

  Expected: the deletion test gets 500 and the cross-account duplicate test gets 201.

- [ ] **Step 3: Implement transactional document cleanup**

  Before deleting the parent, use one SQLite transaction to delete outbox rows for the document and its hooks, delete hooks, delete document-scoped shares/revisions/events/comments/suggestions/asks/feedback/notifications, detach project/phase/release/task `doc_id` references, detach asset `doc_id` references, and finally delete the document.

  Require `access.role` after confirming the caller has an account in the duplicate route. Keep owner and share-key semantics unchanged for authorized callers.

- [ ] **Step 4: Run the focused server tests and confirm they pass**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/docs.test.ts`

  Expected: PASS, including stale, role, deletion, and duplication coverage.

### Task 4: Enforce folder ownership for share-secret reads

**Files:**

- Modify: `server/src/routes/org.ts:548-558`
- Test: `server/test/org.test.ts:42-82`

**Interfaces:**

- Consumes: the authenticated account from `requireAccount`.
- Produces: `GET /api/folders/:id/shares` that returns secrets only for the owning account and returns the existing not-found error for other accounts.

- [ ] **Step 1: Write the failing test**

  Create a second account in the folder test and request the first account's share list with the second account's session; assert 404 and no secret payload.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/org.test.ts`

  Expected: the outsider currently receives 200 and the active share secret.

- [ ] **Step 3: Implement the ownership check**

  Query the folder with `id=? AND owner_id=?` using the authenticated account before selecting secrets. Reuse the same ownership boundary for the existing share-management routes where a shared helper makes the contract clearer.

- [ ] **Step 4: Run the focused test and confirm it passes**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/org.test.ts`

  Expected: PASS.

### Task 5: Isolate template writes and authenticate widget review

**Files:**

- Modify: `server/src/routes/extras.ts:92-218`
- Test: `server/test/pages.test.ts:65-115`

**Interfaces:**

- Consumes: authenticated account identity from `resolveAccess`.
- Produces: same-account template upserts only; cross-account slug conflicts return 409; widget review requires an authenticated account before changing status.

- [ ] **Step 1: Write failing tests**

  Add a second account that submits an existing template slug with different content and assert 409; read the template as its owner and assert the original content remains.

  Attempt widget approval anonymously and assert 401 before approving the same widget through an authenticated agent.

- [ ] **Step 2: Run the focused test and confirm the expected failures**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/pages.test.ts`

  Expected: the cross-account template write currently returns 201 and overwrites content; the anonymous widget review currently returns 200.

- [ ] **Step 3: Implement the minimal route guards**

  Scope the template `ON CONFLICT` update with `WHERE templates.owner_id = excluded.owner_id`, detect zero changes as a 409 conflict, and update only the owning account's row. At the start of widget review, require `resolveAccess(db, req, '').identity.accountId` and throw the existing account-required 401 when absent.

- [ ] **Step 4: Run the focused test and confirm it passes**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/pages.test.ts`

  Expected: PASS.

### Task 6: Apply suggestions at their requested location

**Files:**

- Modify: `server/src/routes/collab.ts:448-461`
- Test: `server/test/collab.test.ts:82-103`

**Interfaces:**

- Consumes: suggestion `type`, `find`, `text`, and serialized `at` values.
- Produces: accepted replace pairs that preserve the matched text's position; `at: 'end'` inserts remain at the document end.

- [ ] **Step 1: Strengthen the failing regression test**

  Assert the replacement appears in the board card where `Ship the API` was found and is not appended as a standalone document-tail line.

- [ ] **Step 2: Run the focused test and confirm the expected failure**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/collab.test.ts`

  Expected: the current implementation removes the match and appends the replacement at the end.

- [ ] **Step 3: Implement location-aware application**

  For a delete/insert replacement pair, capture the matched index and splice the replacement into that index in one operation. For standalone inserts, honor `at: 'end'` and the stored anchor form, with a safe end fallback when an anchor cannot be found. Keep deletion and suggestion status updates unchanged.

- [ ] **Step 4: Run the focused test and confirm it passes**

  Run: `rtk pnpm --filter @can-bang/server exec vitest run server/test/collab.test.ts`

  Expected: PASS.

### Task 7: Enforce the documented core test gate

**Files:**

- Modify: `Makefile:5-12`

**Interfaces:**

- Consumes: the existing `@can-bang/core` package test script.
- Produces: `make check` that runs core tests as well as the existing typecheck, format, server coverage, and web asset smoke checks.

- [ ] **Step 1: Implement the gate change**

  Add `pnpm --filter @can-bang/core test` immediately after the core build in `check`.

- [ ] **Step 2: Run the repository gate**

  Run: `rtk make check`

  Expected: core tests execute and the repository gate passes with the documented coverage threshold.

## Completion evidence

- [ ] Run each focused test command after its corresponding fix.
- [ ] Run `rtk pnpm --filter @can-bang/web typecheck`.
- [ ] Run `rtk make check`.
- [ ] Inspect the final diff and verify every PR 22 thread has a corresponding fix or a documented technical response.
- [ ] Do not claim GitHub threads are resolved until the changes are committed/pushed and the review state is refreshed by the user or an authorized integration step.
