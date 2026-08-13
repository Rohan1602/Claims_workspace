import { http, HttpResponse, delay } from 'msw'
import * as claimsStore from './claimsStore'
import * as docsStore from './documentsStore'

const CLAIM_PERMS = {
  admin: { edit: true, delete: true, assign: true },
  adjuster: { edit: true, delete: false, assign: true },
  viewer: { edit: false, delete: false, assign: false },
} as const

const DOC_PERMS = {
  admin: { edit: true, split: true, merge: true, delete: true, comment: true },
  adjuster: { edit: true, split: true, merge: true, delete: false, comment: true },
  viewer: { edit: false, split: false, merge: false, delete: false, comment: true },
} as const

function roleOf(request: Request) {
  return (request.headers.get('x-role') ?? 'viewer') as keyof typeof CLAIM_PERMS
}

function denyClaim(request: Request, action: keyof typeof CLAIM_PERMS.admin) {
  const role = roleOf(request)
  if (!CLAIM_PERMS[role][action]) return { role, res: HttpResponse.json({ error: `${role} cannot ${action} claims` }, { status: 403 }) }
  return { role, res: null }
}

function denyDoc(request: Request, action: keyof typeof DOC_PERMS.admin) {
  const role = roleOf(request)
  if (!DOC_PERMS[role][action]) return { role, res: HttpResponse.json({ error: `${role} cannot ${action} documents` }, { status: 403 }) }
  return { role, res: null }
}

// Each resolver below is also exported so it can be invoked directly in
// tests with a hand-built Request/params. msw/node keeps relative
// handler paths relative by design, while incoming requests carry
// absolute URLs — path-matching a bare string like '/api/claims'
// against an absolute request URL doesn't resolve outside a real
// browser's location context. Calling the resolver directly sidesteps
// that Node-specific matching gap without changing what runs in the
// browser (the http.get(...) registrations below are unchanged).

export async function listClaims({ request }: { request: Request }) {
  await delay(120) // network-latency simulation, not part of the "real bytes" progress path below
  const url = new URL(request.url)
  const q = url.searchParams
  const result = await claimsStore.query({
    cursor: q.get('cursor'),
    limit: Number(q.get('limit') ?? 100),
    sort: q.get('sort') ?? undefined,
    dir: q.get('dir') ?? undefined,
    status: q.get('status') ?? undefined,
    search: q.get('search') ?? undefined,
  })
  return HttpResponse.json(result)
}

export async function patchClaim({ request, params }: { request: Request; params: any }) {
  const { res } = denyClaim(request, 'edit')
  if (res) return res
  const { changes, rev } = (await request.json()) as any
  const result = await claimsStore.patch(params.id as string, changes, rev)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return HttpResponse.json(result.claim)
}

export async function assignClaim({ request, params }: { request: Request; params: any }) {
  const { res } = denyClaim(request, 'assign')
  if (res) return res
  const { assignedTo, rev } = (await request.json()) as any
  const result = await claimsStore.patch(params.id as string, { assignedTo }, rev)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return HttpResponse.json(result.claim)
}

export async function deleteClaim({ request, params }: { request: Request; params: any }) {
  const { res } = denyClaim(request, 'delete')
  if (res) return res
  const url = new URL(request.url)
  const rev = url.searchParams.get('rev')
  const result = await claimsStore.remove(params.id as string, rev ? Number(rev) : undefined)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return new HttpResponse(null, { status: 204 })
}

export function getManifest({ params }: { params: any }) {
  return HttpResponse.json({ documents: docsStore.manifest(params.claimId as string) })
}

// Streams the document as a real ReadableStream so the client's byte-
// counting progress bar is reading genuine incremental delivery, not a
// timer. Chunk pacing below simulates network latency — in-process
// delivery would otherwise be instantaneous, which defeats the point
// of demonstrating progressive loading at all.
export async function getFile({ request, params }: { request: Request; params: any }) {
  const bytes = docsStore.fileBytes(params.claimId as string, params.docId as string)
  if (!bytes) return new HttpResponse(null, { status: 404 })

  const range = request.headers.get('range')
  if (range) {
    const [startStr, endStr] = range.replace('bytes=', '').split('-')
    const start = parseInt(startStr, 10)
    const end = endStr ? parseInt(endStr, 10) : bytes.length - 1
    const slice = bytes.slice(start, end + 1)
    return new HttpResponse(slice, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(slice.length),
      },
    })
  }

  const chunkCount = 24
  const chunkSize = Math.ceil(bytes.length / chunkCount)
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize))
        await delay(Math.max(15, bytes.length / chunkCount / 4000))
      }
      controller.close()
    },
  })

  return new HttpResponse(stream, {
    headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'text/plain', 'Accept-Ranges': 'bytes' },
  })
}

export async function postComment({ request, params }: { request: Request; params: any }) {
  const { role, res } = denyDoc(request, 'comment')
  if (res) return res
  const { page, text, rev } = (await request.json()) as any
  const result = docsStore.addComment(params.claimId as string, params.docId as string, page, text, role, rev)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return HttpResponse.json(result)
}

export async function patchPage({ request, params }: { request: Request; params: any }) {
  const { res } = denyDoc(request, 'edit')
  if (res) return res
  const { text, rev } = (await request.json()) as any
  const result = docsStore.editPage(params.claimId as string, params.docId as string, Number(params.page), text, rev)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return HttpResponse.json(result)
}

export async function postSplit({ request, params }: { request: Request; params: any }) {
  const { res } = denyDoc(request, 'split')
  if (res) return res
  const { atPage, rev } = (await request.json()) as any
  const result = docsStore.split(params.claimId as string, params.docId as string, atPage, rev)
  if ('error' in result) return HttpResponse.json(result, { status: result.error })
  return HttpResponse.json(result)
}

export async function postMerge({ request, params }: { request: Request; params: any }) {
  const { res } = denyDoc(request, 'merge')
  if (res) return res
  const { targetDocId, rev } = (await request.json()) as any
  const result = docsStore.merge(params.claimId as string, params.docId as string, targetDocId, rev)
  if ('error' in result) return HttpResponse.json(result, { status: result.error })
  return HttpResponse.json(result)
}

export async function deletePage({ request, params }: { request: Request; params: any }) {
  const { res } = denyDoc(request, 'delete')
  if (res) return res
  const url = new URL(request.url)
  const rev = url.searchParams.get('rev')
  const result = docsStore.deletePage(params.claimId as string, params.docId as string, Number(params.page), rev ? Number(rev) : undefined)
  if (result.error === 404) return new HttpResponse(null, { status: 404 })
  if (result.error === 409) return HttpResponse.json({ current: result.current }, { status: 409 })
  return HttpResponse.json(result)
}

export const handlers = [
  http.get('/api/claims', listClaims),
  http.patch('/api/claims/:id', patchClaim),
  http.post('/api/claims/:id/assign', assignClaim),
  http.delete('/api/claims/:id', deleteClaim),
  http.get('/api/documents/:claimId/manifest', getManifest),
  http.get('/api/documents/:claimId/file/:docId', getFile),
  http.post('/api/documents/:claimId/:docId/comments', postComment),
  http.patch('/api/documents/:claimId/:docId/pages/:page', patchPage),
  http.post('/api/documents/:claimId/:docId/split', postSplit),
  http.post('/api/documents/:claimId/:docId/merge', postMerge),
  http.delete('/api/documents/:claimId/:docId/pages/:page', deletePage),
]
