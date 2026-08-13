export type ClaimStatus = 'New' | 'In Review' | 'Pending Docs' | 'Adjudicated' | 'Closed'
export type Channel = 'Email' | 'SFTP' | 'Portal' | 'API'

export interface Claim {
  id: string
  claimant: string
  channel: Channel
  status: ClaimStatus
  amount: number
  submittedAt: string
  assignedTo: string
  docSizeMB: number
  rev: number
}

export interface ClaimsPage {
  rows: Claim[]
  nextCursor: string | null
  total: number
}

export interface PageRange {
  page: number
  start: number
  end: number
}

export interface DocMeta {
  docId: string
  pageCount: number
  rev: number
  pages: PageRange[]
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function req<T>(url: string, opts: RequestInit & { role: string }): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { ...opts.headers, 'x-role': opts.role, 'Content-Type': 'application/json' },
  })
  if (res.status === 204) return undefined as T
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body.error ?? `${res.status} ${res.statusText}`)
  }
  return res.json()
}

export function fetchClaims(params: {
  cursor?: string | null
  limit?: number
  sort?: string
  dir?: 'asc' | 'desc'
  status?: string
  search?: string
  role: string
}) {
  const q = new URLSearchParams()
  if (params.cursor) q.set('cursor', params.cursor)
  q.set('limit', String(params.limit ?? 150))
  if (params.sort) q.set('sort', params.sort)
  if (params.dir) q.set('dir', params.dir)
  if (params.status && params.status !== 'All') q.set('status', params.status)
  if (params.search) q.set('search', params.search)
  return req<ClaimsPage>(`/api/claims?${q}`, { role: params.role })
}

export function editClaim(id: string, changes: Partial<Claim>, rev: number, role: string) {
  return req<Claim>(`/api/claims/${id}`, { method: 'PATCH', body: JSON.stringify({ changes, rev }), role })
}

export function assignClaim(id: string, assignedTo: string, rev: number, role: string) {
  return req<Claim>(`/api/claims/${id}/assign`, { method: 'POST', body: JSON.stringify({ assignedTo, rev }), role })
}

export function deleteClaim(id: string, rev: number, role: string) {
  return req<void>(`/api/claims/${id}?rev=${rev}`, { method: 'DELETE', role })
}

export function fetchManifest(claimId: string, role: string) {
  return req<{ documents: DocMeta[] }>(`/api/documents/${claimId}/manifest`, { role })
}

export function addComment(claimId: string, docId: string, page: number, text: string, rev: number, role: string) {
  return req<{ comment: any; rev: number }>(`/api/documents/${claimId}/${docId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ page, text, rev }),
    role,
  })
}

export function editPage(claimId: string, docId: string, page: number, text: string, rev: number, role: string) {
  return req<{ rev: number }>(`/api/documents/${claimId}/${docId}/pages/${page}`, {
    method: 'PATCH',
    body: JSON.stringify({ text, rev }),
    role,
  })
}

export function splitDocument(claimId: string, docId: string, atPage: number, rev: number, role: string) {
  return req<{ newDocId: string; rev: number }>(`/api/documents/${claimId}/${docId}/split`, {
    method: 'POST',
    body: JSON.stringify({ atPage, rev }),
    role,
  })
}

export function mergeDocument(claimId: string, docId: string, targetDocId: string, rev: number, role: string) {
  return req<{ rev: number; pageCount: number }>(`/api/documents/${claimId}/${docId}/merge`, {
    method: 'POST',
    body: JSON.stringify({ targetDocId, rev }),
    role,
  })
}

export function deletePage(claimId: string, docId: string, page: number, rev: number, role: string) {
  return req<{ rev: number; pageCount: number }>(`/api/documents/${claimId}/${docId}/pages/${page}?rev=${rev}`, {
    method: 'DELETE',
    role,
  })
}

export function docFileUrl(claimId: string, docId: string) {
  return `/api/documents/${claimId}/file/${docId}`
}
