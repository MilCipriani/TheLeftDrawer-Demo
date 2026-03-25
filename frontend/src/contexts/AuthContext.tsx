import { createContext, useContext, useState, useEffect } from 'react'
import type { ReactNode } from 'react'

import { updateToken, setupAuth, fetchWithAuth } from '../api/fetchWithAuth'

interface User {
  id: number
  username: string
}

interface AuthContextType {
  user: User | null
  token: string | null
  login: (accessToken: string, user: User) => void
  logout: () => Promise<void>
  isAuthenticated: boolean
  isLoading: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)  //true until we've checked the cookie, avoids flashing login page

  //On every page load, check if there's a valid refresh token cookie
  //THERE IS -> get a new access token silently while user stays logged in
  //THERE IS NOT -> stay logged out, isLoading becomes false
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include'  //send the HTTP only cookie
        })

        if (response.ok) {
          const data = await response.json()
          updateToken(data.accessToken)
          setToken(data.accessToken)
          setUser(data.user)
        }
      } catch {
        //network error —> stay logged out
      } finally {
        setIsLoading(false)  //check complete
      }
    }

    restoreSession()
  }, [])

  const login = (accessToken: string, newUser: User) => {
    updateToken(accessToken)
    setToken(accessToken)
    setUser(newUser)
  }

  const logout = async () => {
    try {
      await fetchWithAuth('/api/auth/logout', {
        method: 'POST',
        credentials: 'include'
      })
    } finally {
      //success or not, always clear state
      updateToken(null)
      setToken(null)
      setUser(null)
    }
  }

  //wire up setupAuth once —> gives fetchWithAuth access to logout
  useEffect(() => {
    setupAuth(logout)
  }, [])

  return (
    <AuthContext.Provider value={{
      user,
      token,
      login,
      logout,
      isAuthenticated: !!token,
      isLoading
    }}>
      {children}
    </AuthContext.Provider>
  )
}

//eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}