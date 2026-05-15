import './App.css'
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { AuthProvider, useAuth } from './contexts/AuthContext'
import { setNavigate } from './api/fetchWithAuth'
import Login from './pages/Login'
import MainPage from './pages/MainPage'

const queryClient = new QueryClient() //TODO

//separate component so it can use useAuth (hooks only work inside the Provider)
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user } = useAuth()
  const { user: urlUser } = useParams<{ user: string }>()

  if (isLoading) return <div>Loading...</div> //still checking the cookie
  if (!isAuthenticated) return <Navigate to="/" /> //no valid session, go to login
  
  //URL username doesn't match the logged in user
  if (urlUser && user && urlUser !== user.username) {
    return <Navigate to={`/${user.username}`} />
  }

  return <>{children}</>
}

function NavigateInjector() {
  const navigate = useNavigate()
  useEffect(() => {
    setNavigate(navigate)
  }, [navigate])
  return null
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className='min-h-screen w-screen bg-white'>

        <div className='relative z-10'>
          <BrowserRouter>
            <AuthProvider>  {/*inside BrowserRouter so children can use useNavigate*/}
              <NavigateInjector />
              <Routes>
                <Route path="/" element={<Login />} />
                <Route path="/:user/:folderId?" element={
                  <ProtectedRoute>
                    <MainPage />
                  </ProtectedRoute>
                } />
              </Routes>
            </AuthProvider>
          </BrowserRouter>
        </div>
      </div>
    </QueryClientProvider>
  )
}

export default App