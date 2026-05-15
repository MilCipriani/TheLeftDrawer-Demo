//this module holds the current token in memory (outside React)
//so it can be accessed by a plain function without needing hooks
let token: string | null = null
let logoutFn: (() => void) | null = null
let navigateFn: ((path: string) => void) | null = null

//called once from AuthContext to give this module access to auth state
export function setupAuth(logout: () => void) {
  logoutFn = logout
}

//called every time the token changes in AuthContext
export function updateToken(newToken: string | null) {
  token = newToken
}

export function setNavigate(fn: (path: string) => void) {
  navigateFn = fn
}

//replacement for all authenticated fetch requests —> automatic auth headers and token refresh -> intercepts all 403s
export async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  
  //1) request with the current token
  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  })

  //2) if token is expired (403), try to get a new one
  if (response.status === 403) {

    const refreshResponse = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include' //sends the httpOnly cookie
    })

    //3a) Refresh failed —> session is dead, log out
    if (!refreshResponse.ok) {
      logoutFn?.()
      navigateFn?.('/')//kick to login page
      return response //return the original 403
    }

    //3b) Refresh worked —> update the token and retry the original request
    const data = await refreshResponse.json()
    token = data.accessToken
    updateToken(data.accessToken)

    return fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${data.accessToken}`
      }
    })
  }

  return response
}