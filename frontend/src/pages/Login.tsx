import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

import Logo from '../assets/Logo.svg?react'

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
    <div className="flex flex-col items-center justify-center h-screen w-full bg-[#FFE5AD] overflow-clip">
			{/*BACKGROUND GRADIENT*/}
      <div className='w-full h-full absolute top-0 left-0 z-0 overflow-hidden'>
        <div className='absolute top-0 left-0 rounded-full size-124 md:size-400 bg-radial from-[#FF9E3C] to-[#FFA8A8] -translate-1/2 blur-[120px] md:blur-[250px] z-0'></div>
        <div className='absolute bottom-0 right-0 rounded-full size-124 md:size-400 bg-radial from-[#FF9E3C] to-[#FFA8A8] translate-1/2 blur-[120px] md:blur-[250px] z-0'></div>
      </div>

			{/*COMPONENT*/}
			<main className='relative w-full h-full max-h-300 flex flex-col items-center justify-around px-6 pt-16 z-10'>
				{/*TITLE*/}
				<p className='colored-text text-center text-dark-orange text-sm'>→ This product is a MVP, everything you see is still being worked on</p>

				<div className="w-full flex flex-col items-center justify-center">
					<Logo className='w-12 h-12 text-black'/>
					<h1 className='whitespace-pre-line'>Welcome to your <br/><em className='font-serif'>left drawer</em></h1>
				</div>

				<p className='whitespace-pre-line text-center'>Private, secure and free<br /> cloud storage</p>

				{/*LOGIN FORM*/}
				<form onSubmit={handleLogin} className="mb-12 flex flex-col gap-12 w-full max-w-md">
					<div className="flex flex-col gap-8 sm:gap-8">
						<input type="text" placeholder="Username" className='placeholder-dark-orange text-sm' value={username} onChange={(e) => setUsername(e.target.value)} required></input>
						<input type="password" placeholder="Password" className='placeholder-dark-orange text-sm' value={password} onChange={(e) => setPassword(e.target.value)} required></input>
						
					</div>
					{error && <p className="text-red-500">{error}</p>}
					
					<button type="submit" className="primary-button" disabled={loading}>{loading ? 'Logging in...' : 'Login'}</button>				
				</form>

				{/*FUTURE THEME BUTTON*/}
				{/*
				<button className='flex flex-col items-center justify-center ml-auto bg-white rounded-full w-9 h-9 hover:shadow-[0_0_20px_5px_rgba(255,255,255,0.8)]'><div className='bg-orange rounded-full w-7 h-7'></div></button>
				*/}
			</main>
			

    </div>   
  )
}