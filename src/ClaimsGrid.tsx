import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Claim, ClaimStatus, fetchClaims, editClaim, deleteClaim, assignClaim, ApiError } from './api'
import { Role, canClaim } from './rbac'

interface Props {
  role: Role
  onOpenClaim: (claim: Claim) => void
}

const STATUSES: ClaimStatus[] = ['New', 'In Review', 'Pending Docs', 'Adjudicated', 'Closed']
const PAGE_SIZE = 150

export function ClaimsGrid({ role, onOpenClaim }: Props) {
  const [sort, setSort] = useState<keyof Claim>('id')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [status, setStatus] = useState<ClaimStatus | 'All'>('All')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Partial<Claim>>({})
  const [toast, setToast] = useState<string | null>(null)
  const qc = useQueryClient()

  const queryKey = ['claims', sort, dir, status, search, role] as const

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchClaims({ cursor: pageParam, limit: PAGE_SIZE, sort, dir, status, search, role }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })

  const rows = useMemo(() => data?.pages.flatMap((p) => p.rows) ?? [], [data])
  const total = data?.pages[0]?.total ?? 0

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const onError = (err: unknown) => {
    if (err instanceof ApiError) flash(err.status === 403 ? `Denied: ${err.message}` : err.message)
    else flash('Request failed')
  }

  const patchRow = (updated: Claim) =>
    qc.setQueryData(queryKey, (old: any) =>
      old && { ...old, pages: old.pages.map((p: any) => ({ ...p, rows: p.rows.map((r: Claim) => (r.id === updated.id ? updated : r)) })) }
    )

  const removeRow = (id: string) =>
    qc.setQueryData(queryKey, (old: any) =>
      old && { ...old, pages: old.pages.map((p: any) => ({ ...p, rows: p.rows.filter((r: Claim) => r.id !== id) })) }
    )

  const editMut = useMutation({
    mutationFn: ({ claim, changes }: { claim: Claim; changes: Partial<Claim> }) => editClaim(claim.id, changes, claim.rev, role),
    onSuccess: (updated) => {
      patchRow(updated)
      setEditingId(null)
    },
    onError,
  })

  const assignMut = useMutation({
    mutationFn: ({ claim, to }: { claim: Claim; to: string }) => assignClaim(claim.id, to, claim.rev, role),
    onSuccess: patchRow,
    onError,
  })

  const deleteMut = useMutation({
    mutationFn: (claim: Claim) => deleteClaim(claim.id, claim.rev, role),
    onSuccess: (_v, claim) => removeRow(claim.id),
    onError,
  })

  function startEdit(claim: Claim) {
    setEditingId(claim.id)
    setDraft({ status: claim.status, assignedTo: claim.assignedTo, amount: claim.amount })
  }

  const columns: { key: keyof Claim; label: string }[] = [
    { key: 'id', label: 'Claim ID' },
    { key: 'claimant', label: 'Claimant' },
    { key: 'channel', label: 'Channel' },
    { key: 'status', label: 'Status' },
    { key: 'amount', label: 'Amount' },
    { key: 'submittedAt', label: 'Submitted' },
    { key: 'assignedTo', label: 'Assigned To' },
    { key: 'docSizeMB', label: 'Doc Size' },
  ]

  function toggleSort(key: keyof Claim) {
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSort(key)
      setDir('asc')
    }
  }

  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 44,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()

  useEffect(() => {
    const last = items[items.length - 1]
    if (!last) return
    if (last.index >= rows.length - 20 && hasNextPage && !isFetchingNextPage) fetchNextPage()
  }, [items, rows.length, hasNextPage, isFetchingNextPage, fetchNextPage])

  const handleAssign = useCallback(
    (claim: Claim) => {
      const to = window.prompt('Assign to', claim.assignedTo)
      if (to && to !== claim.assignedTo) assignMut.mutate({ claim, to })
    },
    [assignMut]
  )

  return (
    <div className="grid-wrapper">
      <div className="grid-toolbar">
        <input placeholder="Search claimant or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value as any)}>
          <option value="All">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="count">
          {isLoading ? 'Loading…' : `${rows.length.toLocaleString()} of ${total.toLocaleString()} loaded`}
        </span>
      </div>

      <div className="grid-header">
        <div className="grid-row header-row">
          {columns.map((col) => (
            <div className="grid-cell header-cell" key={col.key} onClick={() => toggleSort(col.key)}>
              {col.label}
              {sort === col.key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
            </div>
          ))}
          <div className="grid-cell header-cell">Actions</div>
        </div>
      </div>

      <div ref={parentRef} className="grid-body">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vRow) => {
            const claim = rows[vRow.index]
            if (!claim) return null
            const editing = editingId === claim.id

            return (
              <div
                key={claim.id}
                className="grid-row"
                onClick={() => !editing && onOpenClaim(claim)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${vRow.size}px`, transform: `translateY(${vRow.start}px)` }}
              >
                <div className="grid-cell">{claim.id}</div>
                <div className="grid-cell">{claim.claimant}</div>
                <div className="grid-cell">{claim.channel}</div>
                <div className="grid-cell">
                  {editing ? (
                    <select value={draft.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as ClaimStatus }))}>
                      {STATUSES.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  ) : (
                    claim.status
                  )}
                </div>
                <div className="grid-cell">
                  {editing ? (
                    <input type="number" value={draft.amount} onClick={(e) => e.stopPropagation()} onChange={(e) => setDraft((d) => ({ ...d, amount: Number(e.target.value) }))} />
                  ) : (
                    `$${claim.amount.toLocaleString()}`
                  )}
                </div>
                <div className="grid-cell">{claim.submittedAt}</div>
                <div className="grid-cell">
                  {editing ? (
                    <input value={draft.assignedTo} onClick={(e) => e.stopPropagation()} onChange={(e) => setDraft((d) => ({ ...d, assignedTo: e.target.value }))} />
                  ) : (
                    claim.assignedTo
                  )}
                </div>
                <div className="grid-cell">{claim.docSizeMB.toLocaleString()} MB</div>
                <div className="grid-cell row-actions">
                  {editing ? (
                    <>
                      <button onClick={(e) => { e.stopPropagation(); editMut.mutate({ claim, changes: draft }) }}>Save</button>
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(null) }}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button disabled={!canClaim(role, 'edit')} onClick={(e) => { e.stopPropagation(); startEdit(claim) }}>Edit</button>
                      <button disabled={!canClaim(role, 'assign')} onClick={(e) => { e.stopPropagation(); handleAssign(claim) }}>Assign</button>
                      <button
                        disabled={!canClaim(role, 'delete')}
                        className="danger"
                        onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete ${claim.id}?`)) deleteMut.mutate(claim) }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {toast && <div className="toast grid-toast">{toast}</div>}
    </div>
  )
}
