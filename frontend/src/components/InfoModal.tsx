import Logo from '../assets/Logo.svg?react'

interface InfoModalProps {
  onClose: () => void
}

export default function InfoModal({onClose}: InfoModalProps) {


  return (
    <div className='fixed inset-0 flex items-center justify-center z-50 w-full bg-[#FFE5AD]'>
      {/*BACKGROUND GRADIENT*/}
      <div className='pointer-events-none w-full h-full absolute top-0 left-0 z-0 overflow-hidden'>
        <div className='absolute top-0 left-0 rounded-full size-124 md:size-400 bg-radial from-[#FF9E3C] to-[#FFA8A8] -translate-1/2 blur-[120px] md:blur-[250px] z-0'></div>
        <div className='absolute bottom-0 right-0 rounded-full size-124 md:size-400 bg-radial from-[#FF9E3C] to-[#FFA8A8] translate-1/2 blur-[120px] md:blur-[250px] z-0'></div>
      </div>

      {/*COMPONENT*/}
      <main className='relative z-10 flex flex-col items-center justify-around px-4 py-6 overflow-hidden w-full h-full max-h-250 max-w-230'>
        <div className='flex flex-col w-fit items-center justify-center z-10'>
          <Logo className='w-12 h-12 text-black'/>
          <h1 className='text-2xl text-center'>Welcome to the Left Drawer</h1>
          <h2>Demo</h2>
        </div>
        <ul className='flex flex-col gap-2'>
          <li className='mb-4'>A few things to keep in mind while exploring:</li>
          <li>• File uploads are capped at <strong>100MB</strong>, with a limit of <strong>15 uploads per hour</strong> per IP</li>
          <li>• Every 30 minutes, all sessions are reset and uploaded files are cleared. The next reset time is always shown at the top of the page, in your local timezone</li>
          <li>• Uploads or actions that exceed these limits will fail by design: they're constraints of the demo environment, not the actual product</li>
        </ul>
        <button className='relative z-50 cursor-pointer primary-button touch-manipulation' onClick={onClose}>I understand</button>
      </main>
      
      
    </div>
  )
}