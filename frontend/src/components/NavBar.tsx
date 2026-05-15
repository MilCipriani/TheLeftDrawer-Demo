import Logo from '../assets/Logo.svg?react'
import DotsMenu from '../assets/icons/MenuIcon.svg?react'

interface NavBarProps {
  onLogo: () => void
  onMenu: () => void
}

export default function NavBar({onLogo, onMenu}: NavBarProps) {

  return (
    <div className='flex gap-4 py-2 px-4 bg-orange rounded-4xl z-10'>
      <div className='flex gap-2'>
        <Logo onClick={onLogo} className='cursor-pointer w-6 h-6 text-black'/>
        <p className='font-serif'>Left Dawer</p>
      </div>
      
      <button onClick={onMenu}>
        <DotsMenu className='cursor-pointer h-5'/>
      </button>
      
    </div>
  )
}