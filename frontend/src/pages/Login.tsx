import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

import Logo from '../assets/transpLogoWhite.svg?react'

export default function Login() {
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const { login } = useAuth() 
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	const navigate = useNavigate()

	const handleLogin = async(e: React.SyntheticEvent<HTMLFormElement>) => {
		e.preventDefault() //prevents page refresh
		setError('') //clear any previous errors
		setLoading(true) //show loading state

		try{
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					username: username, //"testuser"
					password: password  //"password123"
				})
			})

			const data = await response.json()		
		
			if (!response.ok) {
					throw new Error(data.error || 'Login failed')
				}

			//success? Save the token for later use
			login(data.accessToken, data.user)

			//navigate to the main page
			navigate(`/${data.user.username}`) //goes to "/testuser"
		}catch (err: unknown) {
			if (err instanceof Error) {
				setError(err.message)
			} else {
				setError('An unknown login error occurred')
			}
		} finally {
			setLoading(false)
		}
	}


  return (
    <main className="h-full w-full flex flex-col items-center justify-start pt-16 gap-16">
			{/*TITLE*/}
			<div className="w-full flex flex-col items-center justify-center sm:flex-row sm:gap-8 p-8 sm:px-16 gap-4">
				<Logo className='login-logo'/>
				<h1 className='uppercase text-white font-light'>The left drawer</h1>
			</div>

			{/*LOGIN FORM*/}
			<form onSubmit={handleLogin} className="bg-white w-5/6 sm:w-2/3 h-fit py-12 sm:py-16 px-6 rounded-3xl flex flex-col gap-16 sm:gap-24 max-w-2xl">
				<div className="flex flex-col gap-4 sm:gap-8">
					<input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required></input>
					<input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required></input>
				</div>
				
				{error && <p className="text-red-500">{error}</p>}

				<button type="submit" className="primary-button" disabled={loading}>{loading ? 'Logging in...' : 'Login'}</button>				
			</form>

    </main>   
  )
}