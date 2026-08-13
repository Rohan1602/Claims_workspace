import * as docs from '../src/mocks/documentsStore'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('ok  ' + msg)
}

const claimId = 'CLM-100010'
const m0 = docs.manifest(claimId)
assert(m0.length === 1, 'starts with one document')
const doc0 = m0[0]
const originalPageCount = doc0.pageCount
console.log(`document has ${originalPageCount} pages`)

// --- comment ---
const c = docs.addComment(claimId, doc0.docId, 3, 'looks fine', 'adjuster', doc0.rev)
assert(!('error' in c), 'comment accepted at correct revision')
const staleComment = docs.addComment(claimId, doc0.docId, 3, 'stale', 'adjuster', doc0.rev) // rev now stale
assert('error' in staleComment && staleComment.error === 409, 'stale-revision comment rejected with 409')

// --- edit page ---
const m1 = docs.manifest(claimId)
const revAfterComment = m1[0].rev
const edit = docs.editPage(claimId, doc0.docId, 5, 'REPLACED PAGE 5 CONTENT\n', revAfterComment)
assert(!('error' in edit), 'edit accepted at correct revision')

// --- split ---
const m2 = docs.manifest(claimId)
const revBeforeSplit = m2[0].rev
const splitAt = Math.floor(originalPageCount / 2)
const splitResult = docs.split(claimId, doc0.docId, splitAt, revBeforeSplit)
assert(!('error' in splitResult), 'split accepted at correct revision')

const m3 = docs.manifest(claimId)
assert(m3.length === 2, 'split produced two documents')
const totalPagesAfterSplit = m3[0].pageCount + m3[1].pageCount
assert(totalPagesAfterSplit === originalPageCount, `page count preserved across split (${totalPagesAfterSplit} === ${originalPageCount})`)

// verify byte ranges are contiguous within each doc and start at 0
for (const d of m3) {
  let expectedStart = 0
  for (const p of d.pages) {
    assert(p.start === expectedStart, `doc ${d.docId.slice(0, 8)} page ${p.page} byte range contiguous`)
    expectedStart = p.end + 1
  }
}

// --- merge back ---
const target = m3[0]
const source = m3[1]
const mergeResult = docs.merge(claimId, source.docId, target.docId, target.rev)
assert(!('error' in mergeResult), 'merge accepted at correct revision')

const m4 = docs.manifest(claimId)
assert(m4.length === 1, 'merge collapsed back to one document')
assert(m4[0].pageCount === originalPageCount, `page count restored after merge (${m4[0].pageCount} === ${originalPageCount})`)

// --- delete page ---
const revBeforeDelete = m4[0].rev
const del = docs.deletePage(claimId, m4[0].docId, 1, revBeforeDelete)
assert(!('error' in del), 'page delete accepted at correct revision')
const m5 = docs.manifest(claimId)
assert(m5[0].pageCount === originalPageCount - 1, 'page count decremented after delete')

// --- RBAC-adjacent: wrong revision on delete ---
const staleDelete = docs.deletePage(claimId, m5[0].docId, 2, 999)
assert('error' in staleDelete && staleDelete.error === 409, 'stale-revision delete rejected with 409')

console.log('\nAll document-store checks passed.')
