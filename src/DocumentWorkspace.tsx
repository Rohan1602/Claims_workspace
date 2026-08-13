import { useEffect, useRef, useState } from 'react'
import {
  Claim,
  DocMeta,
  fetchManifest,
  docFileUrl,
  addComment,
  editPage,
  splitDocument,
  mergeDocument,
  deletePage,
  ApiError,
} from './api'
import { Role, canDoc } from './rbac'

interface Props {
  claim: Claim
  role: Role
  onClose: () => void
}

interface LoadedDoc {
  text: string
  pages: DocMeta['pages']
}

interface Comment {
  id: string
  page: number
  text: string
  author: string
}

type LoadState = 'loading' | 'ready' | 'error'

export function DocumentWorkspace({ claim, role, onClose }: Props) {
  const [documents, setDocuments] = useState<DocMeta[]>([])
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [progress, setProgress] = useState(0)
  const [bytesLoaded, setBytesLoaded] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [commentDraft, setCommentDraft] = useState('')
  const [editingPage, setEditingPage] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)

  const buffers = useRef<Map<string, LoadedDoc>>(new Map())
  const comments = useRef<Map<string, Comment[]>>(new Map())
  const abortRef = useRef<AbortController | null>(null)

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2500)
  }

  const activeMeta = documents.find((d) => d.docId === activeDocId) ?? null

  async function refreshManifest() {
    const { documents: docs } = await fetchManifest(claim.id, role)
    setDocuments(docs)
    return docs
  }

  async function loadDoc(docId: string, signal: AbortSignal) {
    setLoadState('loading')
    setProgress(0)
    setBytesLoaded(0)

    const res = await fetch(docFileUrl(claim.id, docId), { signal })
    if (!res.ok || !res.body) throw new Error(`load failed: ${res.status}`)
    const total = Number(res.headers.get('Content-Length') ?? 0)
    setTotalBytes(total)

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let loaded = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      loaded += value.length
      setBytesLoaded(loaded)
      if (total) setProgress(Math.min(100, Math.round((loaded / total) * 100)))
    }

    const merged = new Uint8Array(loaded)
    let offset = 0
    for (const c of chunks) {
      merged.set(c, offset)
      offset += c.length
    }
    return new TextDecoder().decode(merged)
  }

  useEffect(() => {
    let cancelled = false
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    ;(async () => {
      try {
        const docs = await refreshManifest()
        if (cancelled) return
        const first = docs[0]
        if (!first) throw new Error('no documents for this claim')
        setActiveDocId(first.docId)

        const text = await loadDoc(first.docId, controller.signal)
        if (cancelled) return
        buffers.current.set(first.docId, { text, pages: first.pages })
        comments.current.set(first.docId, [])
        setCurrentPage(1)
        setLoadState('ready')
      } catch {
        if (cancelled || controller.signal.aborted) return
        setLoadState('error')
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim.id, retryTick])

  async function switchDoc(docId: string) {
    setActiveDocId(docId)
    setCurrentPage(1)
    setEditingPage(false)
    if (buffers.current.has(docId)) {
      setLoadState('ready')
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const meta = documents.find((d) => d.docId === docId)!
      const text = await loadDoc(docId, controller.signal)
      buffers.current.set(docId, { text, pages: meta.pages })
      if (!comments.current.has(docId)) comments.current.set(docId, [])
      setLoadState('ready')
    } catch {
      setLoadState('error')
    }
  }

  function retry() {
    setRetryTick((t) => t + 1)
  }

  function cancelLoad() {
    abortRef.current?.abort()
    onClose()
  }

  const loaded = activeDocId ? buffers.current.get(activeDocId) : undefined
  const pageRange = loaded?.pages.find((p) => p.page === currentPage)
  const pageText = loaded && pageRange ? loaded.text.slice(pageRange.start, pageRange.end + 1) : ''
  const pageComments = (activeDocId && comments.current.get(activeDocId)) || []
  const visiblePages = loaded?.pages.map((p) => p.page) ?? []

  async function handleConflict(err: unknown, label: string) {
    if (err instanceof ApiError && err.status === 409) {
      flash(`${label} conflicted with a concurrent change — refreshed to latest`)
      await refreshManifest()
    } else if (err instanceof ApiError && err.status === 403) {
      flash(`Denied: ${err.message}`)
    } else {
      flash(`${label} failed`)
    }
  }

  function startEditPage() {
    setEditDraft(pageText)
    setEditingPage(true)
  }

  async function saveEditPage() {
    if (!activeMeta || !loaded) return
    setBusy('Save page')
    try {
      const { rev } = await editPage(claim.id, activeMeta.docId, currentPage, editDraft, activeMeta.rev, role)
      const before = loaded.text.slice(0, pageRange!.start)
      const after = loaded.text.slice(pageRange!.end + 1)
      const delta = editDraft.length - (pageRange!.end - pageRange!.start + 1)
      const newText = before + editDraft + after
      const newPages = loaded.pages.map((p) => {
        if (p.page < currentPage) return p
        if (p.page === currentPage) return { ...p, end: p.end + delta }
        return { ...p, start: p.start + delta, end: p.end + delta }
      })
      buffers.current.set(activeMeta.docId, { text: newText, pages: newPages })
      setDocuments((docs) => docs.map((d) => (d.docId === activeMeta.docId ? { ...d, rev, pages: newPages } : d)))
      setEditingPage(false)
      flash('Page saved')
    } catch (err) {
      await handleConflict(err, 'Edit')
    } finally {
      setBusy(null)
    }
  }

  async function onAddComment() {
    if (!commentDraft.trim() || !activeMeta) return
    setBusy('Add comment')
    try {
      const { comment, rev } = await addComment(claim.id, activeMeta.docId, currentPage, commentDraft, activeMeta.rev, role)
      const list = comments.current.get(activeMeta.docId) ?? []
      list.push({ id: comment.id, page: comment.page, text: comment.text, author: comment.author })
      comments.current.set(activeMeta.docId, list)
      setDocuments((docs) => docs.map((d) => (d.docId === activeMeta.docId ? { ...d, rev } : d)))
      setCommentDraft('')
    } catch (err) {
      await handleConflict(err, 'Comment')
    } finally {
      setBusy(null)
    }
  }

  async function onSplit() {
    if (!activeMeta) return
    const at = window.prompt(`Split before which page? (2–${activeMeta.pageCount})`, String(currentPage))
    const atPage = Number(at)
    if (!at || Number.isNaN(atPage)) return
    setBusy('Split')
    try {
      await splitDocument(claim.id, activeMeta.docId, atPage, activeMeta.rev, role)
      await refreshManifest()
      flash('Document split')
    } catch (err) {
      await handleConflict(err, 'Split')
    } finally {
      setBusy(null)
    }
  }

  async function onMerge() {
    if (!activeMeta) return
    const idx = documents.findIndex((d) => d.docId === activeMeta.docId)
    const target = documents[idx - 1]
    if (!target) {
      flash('No preceding document to merge into')
      return
    }
    setBusy('Merge')
    try {
      await mergeDocument(claim.id, activeMeta.docId, target.docId, target.rev, role)
      buffers.current.delete(target.docId)
      const docs = await refreshManifest()
      const merged = docs.find((d) => d.docId === target.docId)
      if (merged) await switchDoc(merged.docId)
      flash('Documents merged')
    } catch (err) {
      await handleConflict(err, 'Merge')
    } finally {
      setBusy(null)
    }
  }

  async function onDeletePage() {
    if (!activeMeta) return
    if (!window.confirm(`Delete page ${currentPage}?`)) return
    setBusy('Delete page')
    try {
      await deletePage(claim.id, activeMeta.docId, currentPage, activeMeta.rev, role)
      const docs = await refreshManifest()
      const meta = docs.find((d) => d.docId === activeMeta.docId)
      if (meta && loaded) buffers.current.set(activeMeta.docId, { ...loaded, pages: meta.pages })
      const nextPage = meta?.pages[0]?.page ?? 1
      setCurrentPage((p) => (meta?.pages.some((pg) => pg.page === p) ? p : nextPage))
      flash('Page deleted')
    } catch (err) {
      await handleConflict(err, 'Delete')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="workspace-overlay">
      <div className="workspace-panel">
        <div className="workspace-header">
          <div>
            <strong>{claim.id}</strong> — {claim.claimant}
            {documents.length > 1 && (
              <select className="doc-select" value={activeDocId ?? ''} onChange={(e) => switchDoc(e.target.value)}>
                {documents.map((d, i) => (
                  <option key={d.docId} value={d.docId}>
                    Document {i + 1} ({d.pageCount}p)
                  </option>
                ))}
              </select>
            )}
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        {loadState === 'loading' && (
          <div className="load-state">
            <p>Loading document…</p>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="muted">
              {(bytesLoaded / 1024).toFixed(0)} KB{totalBytes ? ` / ${(totalBytes / 1024).toFixed(0)} KB` : ''} · {progress}%
            </p>
            <button onClick={cancelLoad}>Cancel</button>
          </div>
        )}

        {loadState === 'error' && (
          <div className="load-state error">
            <p>Load failed.</p>
            <button onClick={retry}>Retry</button>
          </div>
        )}

        {loadState === 'ready' && activeMeta && (
          <div className="workspace-body">
            <div className="doc-viewer">
              <div className="doc-page-mock">
                <div className="page-nav">
                  <select value={currentPage} onChange={(e) => { setEditingPage(false); setCurrentPage(Number(e.target.value)) }}>
                    {visiblePages.map((p) => (
                      <option key={p} value={p}>
                        Page {p}
                      </option>
                    ))}
                  </select>
                  <span>{visiblePages.length} pages in this document</span>
                </div>

                {editingPage ? (
                  <>
                    <textarea className="page-canvas editable" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} />
                    <div className="doc-actions">
                      <button onClick={saveEditPage} disabled={!!busy}>Save</button>
                      <button onClick={() => setEditingPage(false)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <pre className="page-canvas">{pageText}</pre>
                )}
              </div>

              {!editingPage && (
                <div className="doc-actions">
                  <button disabled={!canDoc(role, 'edit') || !!busy} onClick={startEditPage}>Edit page</button>
                  <button disabled={!canDoc(role, 'split') || !!busy} onClick={onSplit}>Split</button>
                  <button disabled={!canDoc(role, 'merge') || !!busy} onClick={onMerge}>Merge with previous</button>
                  <button disabled={!canDoc(role, 'delete') || !!busy} className="danger" onClick={onDeletePage}>Delete page</button>
                </div>
              )}
              {busy && <p className="muted">Applying "{busy}"…</p>}
              {toast && <p className="toast">{toast}</p>}
            </div>

            <div className="comments-panel">
              <h4>Page {currentPage} comments</h4>
              <ul>
                {pageComments.filter((c) => c.page === currentPage).map((c) => (
                  <li key={c.id}>
                    <strong>{c.author}:</strong> {c.text}
                  </li>
                ))}
                {pageComments.filter((c) => c.page === currentPage).length === 0 && <li className="muted">No comments on this page yet.</li>}
              </ul>
              {canDoc(role, 'comment') ? (
                <div className="comment-input">
                  <input placeholder="Add a comment…" value={commentDraft} onChange={(e) => setCommentDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onAddComment()} />
                  <button onClick={onAddComment} disabled={!!busy}>Add</button>
                </div>
              ) : (
                <p className="muted">Your role cannot comment.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
