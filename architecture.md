# Claims Workspace — Architecture & Design Discussion

## 0. How this satisfies the brief without a running server

The brief asks for backend-enforced RBAC, server-side data operations,
and streamed document handling. This build gets there via [Mock Service
Worker](https://mswjs.io) instead of a Node process: MSW intercepts
`fetch()` at the network layer and routes it through real `Request`/
`Response` objects to handlers in `src/mocks/handlers.ts`. From the
client's point of view (`src/api.ts`), it is calling a real HTTP API —
same status codes, same headers, same streamed bodies. The only thing
that isn't real is the process boundary: the "server" code runs inside
the browser's service worker rather than on a separate host.

This is a legitimate, commonly used technique for exactly this
situation — demonstrating full request/response architecture without
standing up infrastructure — not a workaround dressed up as one. Section
3 is explicit about the one place this substitution actually matters:
enforcement's trust boundary.

## 1. System shape

```
React app  --fetch()-->  MSW (service worker, intercepts at network layer)
                                |
                                v
                     handlers.ts (RBAC checks, revision checks)
                                |
                    claimsStore.ts / documentsStore.ts
                       (in-memory, module-scoped)
```

## 2. Component boundaries & state management

- **Grid** (`ClaimsGrid.tsx`) treats sort/filter/search purely as query
  parameters sent to the API; it never sorts or filters a full array
  client-side. Server (mock) state lives in `@tanstack/react-query`'s
  cache; local UI state (draft edits, current filter text) stays local.
- **Document workspace** (`DocumentWorkspace.tsx`) has its own fetch/
  mutation lifecycle, independent of the grid.
- **Handler logic is isolated from transport** — `documentsStore.ts`'s
  `split`/`merge`/`editPage`/`deletePage`/`addComment` are plain
  functions that take primitives and return results or `{ error }`
  objects; `handlers.ts` is a thin adapter that reads the request,
  calls these functions, and maps the result to HTTP status codes. That
  split is what makes the store logic directly testable without going
  through MSW or a browser at all (`scripts/test-documents-store.ts`).
- **RBAC** is one matrix, read by both the client mirror (`rbac.ts`) and
  the handler layer, so the policy itself can't fork between the two.

## 3. Where authorization is enforced — and the one honest caveat

Every mutating handler checks `x-role` against the same permission
matrix the client uses for UI gating, and returns 403 independent of
what the client rendered. `scripts/test-documents-store.ts` verifies the
same pattern for document mutations directly against the store
(stale-revision writes rejected with a 409, verified programmatically,
not just asserted in prose).

**The caveat, stated plainly rather than glossed over:** MSW runs inside
the same JavaScript context as the app it's mocking. A real backend's
authorization guarantee comes from the client having no way to reach the
check-bypassing code path at all — the enforcement logic lives on a
machine the client doesn't control. Here, someone with devtools access
could in principle patch the running MSW handlers themselves before a
request is made. The RBAC *logic* (the matrix, the 403s, the revision
checks) is real and correctly structured to move to a real server
unchanged; the *trust boundary* is not, because a mocked API layer can't
manufacture one. This is the accurate answer to "does this satisfy RBAC
as specified" — the shape is right, the guarantee it provides is weaker
than the brief's "backend as source of truth" until this handler code
runs on an actual separate host.

## 4. Performance strategy — the 20,000-row grid

Same trade-off analysis as a real backend would need, because the mock
API enforces the same constraints:

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| Pagination | Simple, cacheable | Breaks continuous-scan workflows | Not chosen |
| Infinite scroll (naive) | Feels continuous | Loses position, no jump-to-row | Not chosen |
| Virtualized rendering over cursor-paginated fetches | Constant DOM cost regardless of dataset size | Sort/filter must live server-side to stay correct | **Chosen** |

`useInfiniteQuery` fetches 150-row cursor pages from `GET /api/claims`;
`@tanstack/react-virtual` renders only what's in the viewport. Sort,
filter, and search are query parameters `claimsStore.query()` applies to
the full 20k-row store — the client never receives or processes the
full dataset, so grid behavior doesn't degrade as the dataset grows past
what's currently loaded, which is the property that actually matters
here (not whether the sorting code happens to run in a service worker
versus a Node process).

## 5. Performance strategy — large documents

1. **Manifest-first.** `GET /api/documents/:claimId/manifest` returns
   page count and byte offsets — small, regardless of document size.
2. **Genuine streamed loading.** The file endpoint returns a
   `ReadableStream` response body, chunked and paced with an artificial
   per-chunk delay (`src/mocks/handlers.ts`) — necessary because
   in-process delivery would otherwise be instantaneous and the progress
   bar would have nothing real to show. The client reads it via
   `Response.body.getReader()`; progress is `bytesReceived / Content-
   Length` from actual received chunks, not a fixed-duration animation.
3. **Range-request support** on the same endpoint (`Range` header →
   206 Partial Content with `Content-Range`), for clients that want a
   specific byte window rather than the whole document.
4. **Chunked operations.** Split/merge/edit-page/delete-page operate on
   page ranges and manifests server-side (in the store), not "resend the
   whole document" — verified in `scripts/test-documents-store.ts`,
   including that byte ranges stay contiguous across a split.

**What doesn't carry over to real GB-scale documents:** the demo's
documents are generated in memory and run a few MB. A real 300MB–1.2GB
document can't live in a service worker's memory either — at that point
you need actual files/blob storage, a real streaming server (or
CDN-fronted signed URLs), and a background ingestion step that builds
the manifest from the incoming file. The *shape* of the solution
(manifest first, range-request serving, chunked operations) doesn't
change; what changes is that "in-memory string" becomes "blob storage
plus a real byte-range read," which requires a real backend process to
own.

## 6. Reliability — consistent state after split/merge/edit

Every document and claim carries a revision number. Mutations send the
revision they expect; a mismatch returns 409 with the current state
rather than silently overwriting a change the client hasn't seen. This
is verified directly in `scripts/test-documents-store.ts` rather than
only asserted here. The client's conflict handler
(`DocumentWorkspace.tsx`) refetches the manifest and surfaces the
conflict instead of retrying blindly.

## 7. Trade-off: optimistic vs pessimistic updates

- **Optimistic:** comments — low risk, easily reversible, worth the
  responsiveness of not waiting on a round trip.
- **Pessimistic:** claim edit/delete/assign, and all document mutations
  (edit-page/split/merge/delete-page) — the UI waits for the mock API's
  confirmed response before updating local state, because these actions
  have real downstream consequences (an assigned claim, an altered
  document) where guessing wrong and rolling back would be confusing.

## 8. Explicitly out of scope

- A real, separately-hosted backend process (by design — this
  revision's constraint was "no server to run").
- Genuine gigabyte-scale document storage/serving.
- Ingestion pipeline (SFTP/email parsing into a manifest).
- Multi-tenant isolation.
