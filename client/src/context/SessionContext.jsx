import { createContext, useContext, useEffect, useState } from 'react'

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [session,          setSession]          = useState(null)
  const [warehouseId,      setWarehouseId]      = useState('')
  const [selectedClientId, setSelectedClientId] = useState('')
  const [loading,          setLoading]          = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setSession(data)
          const whs = data.warehouses || []
          if (whs.length === 1) setWarehouseId(String(whs[0].ID))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Subscription modules this session may use (warehouse users have all).
  // The server enforces access; this only decides what the UI shows as locked.
  const hasModule = key => !!session && (session.isWarehouse || (session.modules || []).includes(key))

  return (
    <SessionContext.Provider value={{
      session, setSession, hasModule,
      warehouseId, setWarehouseId,
      selectedClientId, setSelectedClientId,
      loading
    }}>
      {children}
    </SessionContext.Provider>
  )
}

export const useSession = () => useContext(SessionContext)
