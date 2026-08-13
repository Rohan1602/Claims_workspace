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

let claims: Claim[] | null = null
let byId: Map<string, Claim> | null = null
let loading: Promise<void> | null = null

// Loaded lazily via fetch so the 20k-row dataset stays a separate static
// asset (public/claims.json) instead of getting bundled into the worker
// chunk. The first request pays this cost once; MSW handlers await it.
async function ensureLoaded() {
  if (claims) return
  if (!loading) {
    loading = fetch('/claims.json')
      .then((r) => r.json())
      .then((rows: Omit<Claim, 'rev'>[]) => {
        claims = rows.map((c) => ({ ...c, rev: 1 }))
        byId = new Map(claims.map((c) => [c.id, c]))
      })
  }
  await loading
}

export async function query(params: {
  cursor?: string | null
  limit: number
  sort?: string
  dir?: string
  status?: string
  search?: string
}) {
  await ensureLoaded()
  let rows = claims!
  if (params.status && params.status !== 'All') rows = rows.filter((c) => c.status === params.status)
  if (params.search) {
    const s = params.search.toLowerCase()
    rows = rows.filter((c) => c.claimant.toLowerCase().includes(s) || c.id.includes(params.search!))
  }
  if (params.sort) {
    const key = params.sort as keyof Claim
    const mul = params.dir === 'desc' ? -1 : 1
    rows = [...rows].sort((a, b) => (a[key] > b[key] ? mul : a[key] < b[key] ? -mul : 0))
  }

  const start = params.cursor ? rows.findIndex((r) => r.id === params.cursor) + 1 : 0
  const page = rows.slice(start, start + params.limit)
  const nextCursor = start + params.limit < rows.length ? page[page.length - 1]?.id ?? null : null

  return { rows: page, nextCursor, total: rows.length }
}

export async function patch(id: string, changes: Partial<Claim>, expectedRev?: number) {
  await ensureLoaded()
  const claim = byId!.get(id)
  if (!claim) return { error: 404 as const }
  if (expectedRev != null && claim.rev !== expectedRev) return { error: 409 as const, current: claim }
  Object.assign(claim, changes)
  claim.rev += 1
  return { claim }
}

export async function remove(id: string, expectedRev?: number) {
  await ensureLoaded()
  const claim = byId!.get(id)
  if (!claim) return { error: 404 as const }
  if (expectedRev != null && claim.rev !== expectedRev) return { error: 409 as const, current: claim }
  byId!.delete(id)
  const idx = claims!.findIndex((c) => c.id === id)
  if (idx >= 0) claims!.splice(idx, 1)
  return { ok: true }
}
