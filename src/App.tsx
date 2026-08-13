import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ClaimsGrid } from './ClaimsGrid'
import { DocumentWorkspace } from './DocumentWorkspace'
import { RoleSwitcher } from './RoleSwitcher'
import { Role } from './rbac'
import { Claim } from './api'
import './App.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, retry: 1 } } })

export default function App() {
  const [role, setRole] = useState<Role>('adjuster')
  const [openClaim, setOpenClaim] = useState<Claim | null>(null)

  return (
    <QueryClientProvider client={queryClient}>
      <div className="app">
        <header className="app-header">
          <h1>ABC Insurance — Claims Workspace</h1>
          <RoleSwitcher role={role} onChange={setRole} />
        </header>

        <ClaimsGrid role={role} onOpenClaim={setOpenClaim} />

        {openClaim && <DocumentWorkspace claim={openClaim} role={role} onClose={() => setOpenClaim(null)} />}
      </div>
    </QueryClientProvider>
  )
}
