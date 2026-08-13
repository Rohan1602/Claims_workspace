export interface PageRange {
  page: number
  start: number
  end: number
}

export interface Comment {
  id: string
  page: number
  text: string
  author: string
}

interface DocEntry {
  id: string
  pages: PageRange[]
  text: string
  comments: Comment[]
  rev: number
}

interface ClaimDocs {
  docs: Map<string, DocEntry>
  order: string[]
}

const store = new Map<string, ClaimDocs>()

function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashSeed(str: string) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  return h
}

const LINE =
  'Adjuster notes and claim narrative text, generated for this mock API. ' +
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '

function buildDoc(claimId: string): DocEntry {
  const rand = mulberry32(hashSeed(claimId))
  const pageCount = 40 + Math.floor(rand() * 120)
  const pages: PageRange[] = []
  let text = ''
  let offset = 0
  for (let p = 1; p <= pageCount; p++) {
    const start = offset
    let body = `\n===== PAGE ${p} =====\n`
    for (let i = 0; i < 30; i++) body += LINE + '\n'
    text += body
    offset += body.length
    pages.push({ page: p, start, end: offset - 1 })
  }
  return { id: crypto.randomUUID(), pages, text, comments: [], rev: 1 }
}

function getOrCreate(claimId: string): ClaimDocs {
  let entry = store.get(claimId)
  if (entry) return entry
  const doc = buildDoc(claimId)
  entry = { docs: new Map([[doc.id, doc]]), order: [doc.id] }
  store.set(claimId, entry)
  return entry
}

export function manifest(claimId: string) {
  const entry = getOrCreate(claimId)
  return entry.order.map((id) => {
    const d = entry.docs.get(id)!
    return { docId: d.id, pageCount: d.pages.length, rev: d.rev, pages: d.pages }
  })
}

export function fileBytes(claimId: string, docId: string) {
  const entry = getOrCreate(claimId)
  const doc = entry.docs.get(docId)
  if (!doc) return null
  return new TextEncoder().encode(doc.text)
}

export function addComment(claimId: string, docId: string, page: number, text: string, author: string, expectedRev?: number) {
  const entry = getOrCreate(claimId)
  const doc = entry.docs.get(docId)
  if (!doc) return { error: 404 as const }
  if (expectedRev != null && doc.rev !== expectedRev) return { error: 409 as const, current: doc.rev }
  const comment: Comment = { id: crypto.randomUUID(), page, text, author }
  doc.comments.push(comment)
  doc.rev += 1
  return { comment, rev: doc.rev }
}

export function editPage(claimId: string, docId: string, page: number, newBody: string, expectedRev?: number) {
  const entry = getOrCreate(claimId)
  const doc = entry.docs.get(docId)
  if (!doc) return { error: 404 as const }
  if (expectedRev != null && doc.rev !== expectedRev) return { error: 409 as const, current: doc.rev }
  const range = doc.pages.find((p) => p.page === page)
  if (!range) return { error: 404 as const }
  const before = doc.text.slice(0, range.start)
  const after = doc.text.slice(range.end + 1)
  doc.text = before + newBody + after
  const delta = newBody.length - (range.end - range.start + 1)
  doc.pages = doc.pages.map((p) => {
    if (p.page < page) return p
    if (p.page === page) return { ...p, end: p.end + delta }
    return { ...p, start: p.start + delta, end: p.end + delta }
  })
  doc.rev += 1
  return { rev: doc.rev }
}

export function deletePage(claimId: string, docId: string, page: number, expectedRev?: number) {
  const entry = getOrCreate(claimId)
  const doc = entry.docs.get(docId)
  if (!doc) return { error: 404 as const }
  if (expectedRev != null && doc.rev !== expectedRev) return { error: 409 as const, current: doc.rev }
  const before = doc.pages.length
  doc.pages = doc.pages.filter((p) => p.page !== page)
  doc.comments = doc.comments.filter((c) => c.page !== page)
  if (doc.pages.length === before) return { error: 404 as const }
  doc.rev += 1
  return { rev: doc.rev, pageCount: doc.pages.length }
}

export function split(claimId: string, docId: string, atPage: number, expectedRev?: number) {
  const entry = getOrCreate(claimId)
  const doc = entry.docs.get(docId)
  if (!doc) return { error: 404 as const }
  if (expectedRev != null && doc.rev !== expectedRev) return { error: 409 as const, current: doc.rev }

  const head = doc.pages.filter((p) => p.page < atPage)
  const tail = doc.pages.filter((p) => p.page >= atPage)
  if (!head.length || !tail.length) return { error: 400 as const, message: 'split point out of range' }

  const headEnd = head[head.length - 1].end
  const headText = doc.text.slice(0, headEnd + 1)
  const tailOffset = headEnd + 1
  const tailPages = tail.map((p) => ({ page: p.page, start: p.start - tailOffset, end: p.end - tailOffset }))
  const tailText = doc.text.slice(tailOffset)

  const newDoc: DocEntry = {
    id: crypto.randomUUID(),
    pages: tailPages,
    text: tailText,
    comments: doc.comments.filter((c) => c.page >= atPage),
    rev: 1,
  }
  doc.pages = head
  doc.text = headText
  doc.comments = doc.comments.filter((c) => c.page < atPage)
  doc.rev += 1

  entry.docs.set(newDoc.id, newDoc)
  const idx = entry.order.indexOf(docId)
  entry.order.splice(idx + 1, 0, newDoc.id)

  return { newDocId: newDoc.id, rev: doc.rev }
}

export function merge(claimId: string, docId: string, targetDocId: string, expectedRev?: number) {
  const entry = getOrCreate(claimId)
  const target = entry.docs.get(targetDocId)
  const source = entry.docs.get(docId)
  if (!target || !source) return { error: 404 as const }
  if (expectedRev != null && target.rev !== expectedRev) return { error: 409 as const, current: target.rev }

  const offset = target.text.length
  let nextPage = target.pages.length ? target.pages[target.pages.length - 1].page + 1 : 1
  const remap = new Map<number, number>()
  const movedPages = source.pages.map((p) => {
    remap.set(p.page, nextPage)
    return { page: nextPage++, start: p.start + offset, end: p.end + offset }
  })

  target.text += source.text
  target.pages.push(...movedPages)
  target.comments.push(...source.comments.map((c) => ({ ...c, page: remap.get(c.page) ?? c.page })))
  target.rev += 1

  entry.docs.delete(docId)
  entry.order = entry.order.filter((id) => id !== docId)

  return { rev: target.rev, pageCount: target.pages.length }
}
