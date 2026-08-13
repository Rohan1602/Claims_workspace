# Claims Workspace

Implementation of the ABC Insurance claims case study: a 20,000-row
claims grid and a large-document workspace, backed by a dummy API — real
HTTP requests, real status codes, real RBAC enforcement and revision
conflicts, with no server process to run or deploy.

See [`architecture.md`](./architecture.md) for the design discussion.

## How the dummy API works

[Mock Service Worker](https://mswjs.io) intercepts `fetch()` calls at
the network layer via a browser service worker and routes them to
handlers in `src/mocks/handlers.ts`. The app's `src/api.ts` makes
ordinary `fetch()` calls to `/api/...` — it has no idea MSW exists.
That boundary matters: the client code, the RBAC checks, the revision
conflicts, and the streamed document responses all go through the same
`Request`/`Response` objects a real backend would produce. Swapping MSW
for an actual server later means deleting `src/mocks/` and pointing
`fetch()` at a real host — the client and the handler logic don't change.

## Running it

```bash
npm install
npm run dev
```

Open the printed URL. Switch roles in the header to see both UI gating
and the mock API's 403s (check the network tab).

```bash
npm run build     # type-check + production bundle
npm run test       # logic tests for the document store + RBAC matrix
npm run gen:data   # regenerate public/claims.json (20k rows)
```

## What's real vs. what the mock stands in for

**Real:**
- HTTP request/response cycle for every operation (`fetch` → MSW handler
  → `Response`), including status codes (200/204/206/403/404/409).
- Server-side sort/filter/cursor-pagination over 20,000 claims — the
  client never holds or sorts the full array.
- RBAC checked in the handler layer (`src/mocks/handlers.ts`), not just
  in the UI — a request with `x-role: viewer` gets a real 403 from the
  handler regardless of what the client rendered.
- Revision-checked mutations — stale writes get a real 409 with the
  current server state, verified in `npm run test`.
- Streamed document loading via a genuine `ReadableStream` response body
  and a `ReadableStream.getReader()` on the client — the progress bar is
  bytes actually received, not a timer.
- HTTP range-request support on the document endpoint (`Range` /
  `Content-Range` / 206 Partial Content).

**Standing in for a real backend:**
- Data lives in an in-memory module (`src/mocks/claimsStore.ts`,
  `documentsStore.ts`) inside the browser's service worker, not a
  database — it resets on a hard reload / worker restart.
- `x-role` is a header the client sets itself, standing in for a role
  claim a real system would read from a verified session/JWT. Enforcement
  logic is real; the trust boundary isn't, because there's no separate
  process the client can't reach into.
- Documents are generated in-memory (a few KB/page) rather than sourced
  from ingested files, and run a few MB total rather than the
  300MB–1.2GB the brief specifies.

`architecture.md` covers exactly what moves to a real server and why,
without changing the client or handler code shape.

## Structure

```
scripts/
  generate-claims.mjs        one-time static dataset generator
  test-documents-store.ts     logic tests: split/merge/edit/delete/comment
  test-rbac.ts                logic tests: permission matrix
public/
  claims.json                  generated dataset (20k rows)
  mockServiceWorker.js          MSW's browser worker script
src/
  mocks/
    handlers.ts                the dummy API's routes (RBAC, revisions, streaming)
    claimsStore.ts              in-memory claims data + query logic
    documentsStore.ts           in-memory documents, split/merge/edit/delete
    browser.ts                  MSW worker setup
  api.ts                        fetch wrappers the app actually calls
  rbac.ts                       client-side permission mirror (UI gating)
  ClaimsGrid.tsx                 virtualized grid, infinite query, mutations
  DocumentWorkspace.tsx          streamed doc loading, page nav, mutations
  RoleSwitcher.tsx
  App.tsx / main.tsx
```

## Stack

React 18 + TypeScript + Vite · MSW (dummy API layer) ·
`@tanstack/react-query`, `@tanstack/react-virtual`
