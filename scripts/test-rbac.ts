import { canClaim, canDoc } from '../src/rbac'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg)
  console.log('ok  ' + msg)
}

assert(canClaim('admin', 'delete') === true, 'admin can delete claims')
assert(canClaim('adjuster', 'delete') === false, 'adjuster cannot delete claims')
assert(canClaim('viewer', 'edit') === false, 'viewer cannot edit claims')
assert(canClaim('viewer', 'assign') === false, 'viewer cannot assign claims')
assert(canDoc('viewer', 'comment') === true, 'viewer can still comment on documents')
assert(canDoc('viewer', 'split') === false, 'viewer cannot split documents')
assert(canDoc('adjuster', 'delete') === false, 'adjuster cannot delete document pages')
assert(canDoc('admin', 'delete') === true, 'admin can delete document pages')

console.log('\nAll RBAC matrix checks passed.')
