// UI-side mirror of the permission matrix enforced by the mock API
// (src/mocks/handlers.ts). This layer only hides/disables actions before
// a round-trip; every mutating request is re-checked against the same
// matrix in the MSW handler regardless of what the client rendered.
// A real backend would enforce this from a verified session/JWT instead
// of the x-role header the mock API reads — see architecture.md.

export type Role = 'admin' | 'adjuster' | 'viewer'
export type ClaimAction = 'edit' | 'delete' | 'assign'
export type DocAction = 'edit' | 'split' | 'merge' | 'delete' | 'comment'

const claimPerms: Record<Role, Record<ClaimAction, boolean>> = {
  admin: { edit: true, delete: true, assign: true },
  adjuster: { edit: true, delete: false, assign: true },
  viewer: { edit: false, delete: false, assign: false },
}

const docPerms: Record<Role, Record<DocAction, boolean>> = {
  admin: { edit: true, split: true, merge: true, delete: true, comment: true },
  adjuster: { edit: true, split: true, merge: true, delete: false, comment: true },
  viewer: { edit: false, split: false, merge: false, delete: false, comment: true },
}

export const canClaim = (role: Role, action: ClaimAction) => claimPerms[role][action]
export const canDoc = (role: Role, action: DocAction) => docPerms[role][action]
