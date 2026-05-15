import { useState, useEffect, useRef } from 'react'
import { fetchWithAuth } from '../api/fetchWithAuth'

import FolderIcon from '../assets/icons/FolderIcon.svg?react'


interface MoveModalProps {
  folderId? : string
  selectedFolders: Set<number>
  setSelectedFolders: React.Dispatch<React.SetStateAction<Set<number>>>
  selectedFiles: Set<string>
  setSelectedFiles: React.Dispatch<React.SetStateAction<Set<string>>>
  setSelectionMode: React.Dispatch<React.SetStateAction<boolean>>
  loadFolder: (folderId? : string)=>void
  setShowMoveModal: React.Dispatch<React.SetStateAction<boolean>>
  addToast: (message : string)=> void
}

interface Folder {
  id: number
  user_id: number
  name: string
  parent_folder_id: number | null
  path: string
  created_at: string
}

interface NasFile { //not "File" to avoid shadowing the browser's built-in "File" type
  id: string
  user_id: string
  filename: string
  original_filename: string
  parent_folder_id: number
  file_path: string
  file_size: number
  folder_id: string
  mime_type: string
  created_at: string
  updated_at: string
}

interface FolderContentsResponse {
  folders: Folder[]
  files: NasFile[]
  currentFolder: Folder
}


export default function MoveModal({ setShowMoveModal, selectedFolders, setSelectedFolders, selectedFiles, setSelectedFiles, setSelectionMode, loadFolder, folderId, addToast}: MoveModalProps) {
  const [modalFolderId, setModalFolderId] = useState<number | null>(null)
  const [modalFolders, setModalFolders] = useState<Folder[]>([])
  const [loadingModalFolders, setLoadingModalFolders] = useState(false)

  const lastClickTime = useRef(0)
  const lastClickFolder = useRef<number | null>(null)
  const [movingTo, setMovingTo] = useState<number | null>(null)

  const loadModalFolders = async (folderId: number | null) => {
    setLoadingModalFolders(true)
    try {
      const url = folderId ? `/api/folders/${folderId}` : '/api/folders'
      const response = await fetchWithAuth(url)
      const data: FolderContentsResponse = await response.json()
      setModalFolders(data.folders)
      setModalFolderId(folderId)
      setMovingTo(data.currentFolder.id)
    } catch (err) {
      console.error('Failed to load folders:', err)
    } finally {
      setLoadingModalFolders(false)
    }
  }

  useEffect(() => {
    //eslint-disable-next-line react-hooks/set-state-in-effect -- loadModalFolders is async, no cascading render risk
    loadModalFolders(null)
  }, [])

  //Move modal double clicking issue fix:
  function handleMoveClick(folder:Folder) {
    //eslint-disable-next-line react-hooks/purity -- handleMoveClick is a custom event handler not recognized by linter. Date.now won't fire on every render, only whe the handler is called by a user action
    const now = Date.now()
    const isDoubleClick = now - lastClickTime.current < 300 && lastClickFolder.current === folder.id

    if (isDoubleClick) {
      // double click
      lastClickTime.current = 0
      lastClickFolder.current = null
      setMovingTo(folder.id)
      loadModalFolders(folder.id)
    } else {
      // single click
      lastClickTime.current = now
      lastClickFolder.current = folder.id
      setTimeout(() => {
        if (lastClickFolder.current === folder.id) {
          setMovingTo(folder.id)
          lastClickFolder.current = null
        }
      }, 300)
    }
  }

  const handleMove = async () => {
    if (!movingTo) return

    const fileIds = Array.from(selectedFiles)
    const folderIds = Array.from(selectedFolders)

    try {
      const response = await fetchWithAuth('/api/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fileIds, folderIds, targetFolderId: movingTo })
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      setShowMoveModal(false)
      setSelectedFiles(new Set())
      setSelectedFolders(new Set())
      setSelectionMode(false)
      setMovingTo(null)
      loadFolder(folderId)
    } catch (err) {
      setShowMoveModal(false)
      setSelectedFiles(new Set())
      setSelectedFolders(new Set())
      setSelectionMode(false)
      setMovingTo(null)
      addToast(`Move failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center text-white overflow-hidden" onClick={() => setShowMoveModal(false)}>
      <div className="w-full h-full flex flex-col gap-16 p-2 items-center justify-center bg-black" onClick={e => e.stopPropagation()}>
        <h2>Move to...</h2>

        {/* Back button */}
        {modalFolderId !== null && (
          <button onClick={() => loadModalFolders(null)} className="cursor-pointer bg-white hover:bg-gray-300 rounded-xl p-2 text-sm text-black">
            ← Home
          </button>
        )}


        {loadingModalFolders ? (
          <p className='text-white font-light'>Loading folders...</p>
        ) : (
            
          <div className='flex justify-center gap-6 flex-wrap overflow-auto max-h-1/2'>
            {modalFolders
            .filter(f => !Array.from(selectedFolders).includes(f.id))
            .map(folder => (
              <div
                onClick={() => handleMoveClick(folder)}
                key={folder.id}
                className='flex flex-col w-24 cursor-pointer hover:opacity-80 transition-opacity'>
                <div className={`${movingTo === folder.id ? 'text-cyan-400' : 'text-white'} w-full aspect-square`}>
                  <FolderIcon className="w-full h-full rounded-sm" preserveAspectRatio="none" />
                </div>
                

                <span style={{display: '-webkit-box'}}
                  className={`${movingTo === folder.id ? 'text-cyan-400' : 'text-white'} text-center wrap-break-word overflow-hidden block line-clamp-2`}>
                  {folder.name}
                </span>
              </div>
            ))}
            {modalFolders.length === 0 && (
              <p className="text-white text-sm">No subfolders here</p>
            )}
          </div>
        )}


        <div className="flex gap-8">
          <button onClick={() => {setShowMoveModal(false);
            setModalFolderId(null);
            setModalFolders([]);
            setSelectedFiles(new Set())
            setSelectedFolders(new Set())
            setSelectionMode(false)}}
            className='p-4 cursor-pointer text-sm px-4 py-2 rounded-xl transition-colors bg-red-400 text-black hover:bg-red-600'>Cancel</button>
          <button onClick={handleMove} disabled={!movingTo} className='p-4 cursor-pointer text-sm px-4 py-2 rounded-xl transition-colors bg-orange text-black hover:bg-[#ffa646]'>
            Move here
          </button>
        </div>
      </div>
    </div>
  )
}