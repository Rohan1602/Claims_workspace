import { Role } from './rbac'

interface Props {
  role: Role
  onChange: (role: Role) => void
}

export function RoleSwitcher({ role, onChange }: Props) {
  return (
    <div className="role-switcher">
      <label>Viewing as</label>
      <select value={role} onChange={(e) => onChange(e.target.value as Role)}>
        <option value="admin">Admin</option>
        <option value="adjuster">Adjuster</option>
        <option value="viewer">Viewer</option>
      </select>
    </div>
  )
}
