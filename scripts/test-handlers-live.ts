import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import * as h from '../src/mocks/handlers'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('ok  ' + msg)
}

// claimsStore lazy-loads /claims.json via fetch(); stub just that one
// path so the real query/patch/remove logic runs against the real
// 20k-row dataset, same as in the browser.
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any) => {
  const url = typeof input === 'string' ? input : input.url
  if (url.endsWith('/claims.json')) {
    const path = fileURLToPath(new URL('../public/claims.json', import.meta.url))
    return new Response(readFileSync(path), { status: 200 })
  }
  return realFetch(input as any)
}) as any

function req(url: string, opts: RequestInit & { role?: string } = {}) {
  const { role, ...rest } = opts
  const headers = new Headers(rest.headers)
  if (role) headers.set('x-role', role)
  return new Request(url, { ...rest, headers })
}

async function main() {
  // --- claims list, real sort ---
  let res = await h.listClaims({ request: req('http://x/api/claims?limit=3&sort=amount&dir=desc', { role: 'adjuster' }) })
  assert(res.status === 200, 'listClaims -> 200')
  let body: any = await res.json()
  assert(body.rows.length === 3, 'returns requested page size')
  assert(body.rows[0].amount >= body.rows[1].amount, 'sort=amount&dir=desc actually sorts descending')
  assert(body.total === 20000, 'total reflects full dataset (20000)')

  // --- RBAC: viewer delete claim -> 403 ---
  res = await h.deleteClaim({ request: req('http://x/api/claims/CLM-100000', { method: 'DELETE', role: 'viewer' }), params: { id: 'CLM-100000' } })
  assert(res.status === 403, 'viewer deleteClaim -> 403')

  // --- admin edit claim, then stale-rev conflict ---
  res = await h.patchClaim({
    request: req('http://x/api/claims/CLM-100001', { method: 'PATCH', role: 'admin', body: JSON.stringify({ changes: { status: 'Closed' }, rev: 1 }) }),
    params: { id: 'CLM-100001' },
  })
  assert(res.status === 200, 'admin patchClaim at correct rev -> 200')
  body = await res.json()
  assert(body.status === 'Closed' && body.rev === 2, 'edit applied and revision incremented')

  res = await h.patchClaim({
    request: req('http://x/api/claims/CLM-100001', { method: 'PATCH', role: 'admin', body: JSON.stringify({ changes: { status: 'New' }, rev: 1 }) }), // stale
    params: { id: 'CLM-100001' },
  })
  assert(res.status === 409, 'stale-revision patchClaim -> 409')

  // --- manifest ---
  res = h.getManifest({ params: { claimId: 'CLM-100005' } }) as any
  body = await (res as Response).json()
  assert(body.documents.length === 1, 'manifest starts with one document')
  const docId = body.documents[0].docId
  const pageCount = body.documents[0].pageCount
  console.log(`   document has ${pageCount} pages`)

  // --- streamed file load: real bytes via ReadableStream ---
  res = await h.getFile({ request: req('http://x/api/documents/CLM-100005/file/' + docId, { role: 'adjuster' }), params: { claimId: 'CLM-100005', docId } })
  assert(res.status === 200, 'getFile -> 200')
  assert(res.body != null, 'response has a real streamable body')
  const contentLength = Number(res.headers.get('Content-Length'))
  assert(contentLength > 0, 'Content-Length header present and > 0')

  const reader = res.body!.getReader()
  let received = 0
  let chunkCount = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    chunkCount++
  }
  assert(chunkCount > 1, `document delivered in multiple chunks (${chunkCount}) — genuinely streamed`)
  assert(received === contentLength, `bytes received (${received}) match declared Content-Length (${contentLength})`)

  // --- range request ---
  res = await h.getFile({
    request: req('http://x/api/documents/CLM-100005/file/' + docId, { role: 'adjuster', headers: { Range: 'bytes=0-99' } }),
    params: { claimId: 'CLM-100005', docId },
  })
  assert(res.status === 206, 'Range request -> 206 Partial Content')
  assert(res.headers.get('Content-Range') === `bytes 0-99/${contentLength}`, 'Content-Range header correct')
  const rangeBuf = await res.arrayBuffer()
  assert(rangeBuf.byteLength === 100, 'range response body is exactly the requested byte count')

  // --- viewer split -> 403 ---
  res = await h.postSplit({
    request: req('http://x/api/documents/CLM-100005/' + docId + '/split', { method: 'POST', role: 'viewer', body: JSON.stringify({ atPage: 10, rev: 1 }) }),
    params: { claimId: 'CLM-100005', docId },
  })
  assert(res.status === 403, 'viewer postSplit -> 403')

  // --- admin split -> 200, verify manifest updates ---
  res = await h.postSplit({
    request: req('http://x/api/documents/CLM-100005/' + docId + '/split', { method: 'POST', role: 'admin', body: JSON.stringify({ atPage: 10, rev: 1 }) }),
    params: { claimId: 'CLM-100005', docId },
  })
  assert(res.status === 200, 'admin postSplit -> 200')

  res = h.getManifest({ params: { claimId: 'CLM-100005' } }) as any
  body = await (res as Response).json()
  assert(body.documents.length === 2, 'manifest reflects two documents after split')
  const total = body.documents[0].pageCount + body.documents[1].pageCount
  assert(total === pageCount, `total pages preserved across split (${total} === ${pageCount})`)

  console.log('\nAll live handler-resolver checks passed against the real handler code.')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
