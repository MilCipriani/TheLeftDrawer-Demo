import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

import { fetchWithAuth } from '../api/fetchWithAuth' //intercepts 403s to refresh tokens

import FolderIcon from '../assets/icons/FolderIcon.svg?react'
import PreviewModal from '../components/PreviewModal'
import ThumbnailImage from '../components/thumbnailIntersectionObserver' //lazy loading for thumbnails
import InfoModal from '../components/InfoModal'
import NavBar from '../components/NavBar'
import MoveModal from '../components/MoveModal'
import VideoIcon from '../assets/icons/video.svg?react'
import Upload from '../assets/icons/upload.svg?react'
import Logout from '../assets/icons/logout.svg?react'
import MoveIcon from '../assets/icons/move.svg?react'
import TrashIcon from '../assets/icons/trash.svg?react'
import LoadingIcon from '../assets/icons/loadingIcon.svg?react'

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

interface Toast {
  id: number
  message: string
}

export default function Home() {
  const { user, folderId } = useParams<{ user: string; folderId?: string }>()
  const navigate = useNavigate()
  const { logout } = useAuth() //context
  const [currentFolder, setCurrentFolder] = useState<Folder | null>(null)
  const [folders, setFolders] = useState<Folder[]>([])
  const [files, setFiles] = useState<NasFile[]>([])
  const [loading, setLoading] = useState<boolean>(true)

  //main menu
  const [menuToggler, setMenuToggler] = useState<boolean>(false)

  //info modal
  const [infoModal, setInfoModal] = useState<boolean>(true)

  //toast
  const [toasts, setToasts] = useState<Array<Toast>>([]);

  //selection mode
  const [selectionMode, setSelectionMode] = useState<boolean>(false)
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set())

  const hasSelections = selectedFiles.size > 0 || selectedFolders.size > 0
  const selectionCount = selectedFiles.size + selectedFolders.size

  //make new folder
  const [showNewFolderModal, setNewFolderShowModal] = useState<boolean>(false)
  const [newFolderName, setNewFolderName] = useState<string>('')
  const [folderError, setFolderError] = useState<string>('')

  //upload file
  const uploadfileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  //delete confirmation message
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<boolean>(false)

  //preview modal
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  //move files and folders
  const [showMoveModal, setShowMoveModal] = useState(false)

  //demo wipe timer
  const [pagewipe, setPagewipe] = useState<string>('')

  const loadFolder = useCallback(async (folderIdParam: string | undefined): Promise<void> => {
    try {
      const url = folderIdParam 
        ? `/api/folders/${folderIdParam}` 
        : '/api/folders'

      const response = await fetchWithAuth(url)

      if (!response.ok) {
        const error = await response.json()
        console.error('Failed to load folder:', error)
        
        throw new Error(error.error || 'Failed to load folder')
      }

      const data: FolderContentsResponse = await response.json()
      
      setFolders(data.folders)
      setFiles(data.files)
      setCurrentFolder(data.currentFolder)
    } catch (err) {
      console.error('Failed to load folders:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  //load folders when component first renders or when you change position in the tree
  useEffect(() => {
    //eslint-disable-next-line react-hooks/set-state-in-effect -- loadFolder is async, no cascading render risk
    loadFolder(folderId)
  }, [folderId, loadFolder])

  //disable scrolling when full page elements are active
  useEffect(() => {
    if (showMoveModal || previewIndex != null) {
      document.documentElement.style.overflow = 'hidden'
    } else {
      document.documentElement.style.overflow = ''
    }
    return () => {
      document.documentElement.style.overflow = ''
    }
  }, [showMoveModal, previewIndex])


  //make Toast (for errors and deleted message)
  const addToast = (message: string) => {
    const id = Date.now(); //unique id
    setToasts(prev => [...prev, { id, message }]);
  };

  //remove Toast
  const removeToast = (id: number) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  //fetching the timer for wiping files on demo
  const lastWipeTimeRef = useRef<string | null>(null)

  useEffect(() => {
    const fetchPageWipe = async () => {
      try {
        const res = await fetch('/api/next-wipe')
        const data = await res.json()

        if (lastWipeTimeRef.current && new Date(data.nextWipeAt) > new Date(lastWipeTimeRef.current)) {
          addToast('Demo data has been wiped. Please refresh the page.')
          return //stop updating the timer
        }

        lastWipeTimeRef.current = data.nextWipeAt
        const formattedDate = new Date(data.nextWipeAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit'
        })
        setPagewipe(formattedDate)

      } catch (err) {
        console.log(err)
      }
    }

    fetchPageWipe()
    const interval = setInterval(fetchPageWipe, 60_000) //every minute
    return () => clearInterval(interval) //cleanup when component unmounts
  }, [])


  if (loading) return <p className='text-sm text-white'>Loading...</p>

  //make new folder
  const createFolder = async () => {
    if (!newFolderName.trim()) {
      addToast('Please enter a folder name')
      return
    }

    try {      
      const response = await fetchWithAuth('/api/folders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: newFolderName,
          parentFolderId: folderId ? parseInt(folderId) : currentFolder?.id,
        })
      })

      if (!response.ok) {
        const error = await response.json()
        addToast(error.error || 'Failed to create folder')
        return
      }

      setNewFolderShowModal(false)
      setNewFolderName('')
      loadFolder(folderId)
    } catch (err) {
      console.error('Failed to create folder:', err)
      addToast('Failed to create folder')
    }
  }

  //upload file
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    setUploading(true);

    const formData = new FormData();

    for (const file of selectedFiles) {
      formData.append("files", file);
    }

    formData.append("folderId", currentFolder?.id?.toString() ?? "");

    try {
      const res = await fetchWithAuth(`/api/files/upload?folderId=${currentFolder?.id}`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error("Upload failed");

      loadFolder(folderId);
    } catch (err) {
      console.error(err);
      addToast('Failed to upload files. Did you exceed the demo limits?')
    } finally {
      setUploading(false);
      if (uploadfileInputRef.current) {
        uploadfileInputRef.current.value = "";
      }
    }
  };

  //toggle selection mode
  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode)
    //clear selections when exiting selection mode
    if (selectionMode) {
      setSelectedFiles(new Set())
      setSelectedFolders(new Set())
    }
  }

  const handleFolderClick = (folder: Folder) => {
    if (selectionMode) {
      setSelectedFolders(prev => {
        const newSet = new Set(prev)
        if (newSet.has(folder.id)) {
          newSet.delete(folder.id)
        } else {
          newSet.add(folder.id)
        }
        return newSet
      })
    } else {
      navigate(`/${user}/${folder.id}`)
    }
  }

  const handleFileClick = (file: NasFile) => {
    if (selectionMode) {
      setSelectedFiles(prev => {
        const newSet = new Set(prev)
        if (newSet.has(file.id)) {
          newSet.delete(file.id)
        } else {
          newSet.add(file.id)
        }
        return newSet
      })
    } else {
      //open preview if it's previewable (img)
      const previewIdx = files.findIndex(f => f.id === file.id)
      if (previewIdx !== -1) {
        setPreviewIndex(previewIdx)
      }
    }
  }

  //delete selected items
  const handleDelete = async () => {
    const fileIds = Array.from(selectedFiles)
    const folderIds = Array.from(selectedFolders)

    try {
      const response = await fetchWithAuth('/api/delete', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileIds: fileIds,
          folderIds: folderIds
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete items')
      }

      addToast(`Delete successful: ${data.message}`)

      //refresh current folder
      await loadFolder(folderId)

    } catch (error) {
      console.error('Delete error:', error)
      addToast(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      //clear selections and exit selection mode
      setSelectedFiles(new Set())
      setSelectedFolders(new Set())
      setSelectionMode(false)
    }
  }

  const handlePreviewDelete = (fileId: string) => {
  const newFiles = files.filter(f => f.id !== fileId)
    setFiles(newFiles)

    if (newFiles.length === 0) {
      setPreviewIndex(null) //no files left, close modal
    } else {
      //clamp index so it doesn't go out of bounds after deletion
      setPreviewIndex(i => Math.min(i!, newFiles.length - 1))
    }
  }


  return (
    <main className="h-full w-full flex flex-col items-center justify-start pt-16 pb-36 px-4 sm:px-16 2xl:px-64 gap-12">

      {/*LOADING ICON*/}
      {uploading && (
        <LoadingIcon className='w-6 h-6 fixed top-4 left-4 animate-spin'/>
      )}

      {/*NAVBAR*/}
      <div className='sticky top-4 flex flex-col z-30'>
        <NavBar onLogo={() => navigate(`/${user}`)} onMenu={()=> setMenuToggler(!menuToggler)}/>
        {menuToggler && (
          <>
            {/*invisible overlay behind the menu but on top ov everything else to catch outside clicks*/}
            <div className='fixed inset-0 z-[-1]' onClick={() => setMenuToggler(false)} />
            
            <div className='absolute top-5 pt-7 pb-4 px-5 left-0 w-full flex flex-col items-start justify-center gap-2 bg-orange rounded-b-4xl z-0'>
              <button className='cursor-pointer flex gap-2' onClick={() => {setMenuToggler(false); setNewFolderShowModal(true)}}><FolderIcon className='w-6 h-6'/>New folder</button>
              <input className='cursor-pointer' type="file" ref={uploadfileInputRef} multiple onChange={(e) => { setMenuToggler(false); handleUpload(e)}} style={{ display: "none" }}/>
              <button className='cursor-pointer flex gap-2' onClick={() => uploadfileInputRef.current?.click()} disabled={uploading}><Upload className='w-6 h-6'/>{uploading ? 'Uploading...' : 'Upload file'}</button>
              <button className='text-red-600 cursor-pointer flex gap-2' onClick={async () => {await logout(); navigate('/')}}><Logout className='w-6 h-6'/>Logout</button>
            </div>
          </>
        )}
      </div>


      {/*<p className='text-left w-full text-sm'>bread &gt; crumb &gt; here &gt; TODO</p>*/}

      <p className='bg-white px-4 py-2 rounded-3xl sticky top-16 text-center'>Full data wipe<br/> at {pagewipe}</p>

      {/*SELECTION MODE TOGGLE*/}
      <button className='cursor-pointer ml-auto flex gap-1 place-items-center' onClick={()=>toggleSelectionMode()}>
        <p>Selection mode</p>
        <div className={`w-6 h-6 border-5 ${selectionMode? 'border-cyan-300' : 'border-black'} bg-black rounded-full ml-auto`}></div>
      </button>

      {/*INFO BUTTON*/}
      {!infoModal && (
        <button className='z-20 bg-black rounded-full w-16 aspect-square flex items-center justify-center fixed bottom-8 left-4 sm:left-16 2xl:left-64 cursor-pointer' onClick={() => setInfoModal(true)}>
          <p className='text-blue-400 font-serif text-5xl'>i</p>
        </button>
      )}

      {infoModal && (
        <InfoModal onClose={()=>setInfoModal(false)}/>
      )}

      {/*NEW FOLDER NAME MODAL*/}
      {showNewFolderModal && (
        <div className='z-50 fixed inset-0 w-full h-full flex flex-col items-center bg-black/50 backdrop-blur-sm'>
          <div className='w-fit h-full flex flex-col items-center justify-center px-8 py-4 gap-4'>
            <p className='text-white'>Name your new folder</p>
            <input 
              type='text' 
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createFolder()}
              autoFocus
            />
            {folderError && (
              <p className='text-red-500'>{folderError}</p>
            )}
            <div className='flex items-center justify-between w-full'>
              <button className='text-red-500 cursor-pointer bg-white rounded-4xl py-2 px-4' onClick={() => {setNewFolderShowModal(false); setFolderError('')}}>Cancel</button>
              <button className='cursor-pointer text-white bg-black py-2 px-4 rounded-4xl' onClick={createFolder}>Create</button>
            </div>
          </div>
           
        </div>
      )}

      {/*SELECTION OPTIONS*/}
      {selectionMode && (
        <div className='fixed z-50 bottom-16 right-1/2 translate-x-1/2 flex flex-col items-start justify-center px-4 pt-2 pb-4 gap-4 bg-orange rounded-2xl'>
          <p className='w-full text-sm text-dark-orange text-center'>{selectionCount>= 0 && `${selectionCount} element(s) selected`}</p>
          <div className='flex gap-1 items-center justify-around w-full'>
            {selectionMode && hasSelections && (
              <button className='flex gap-1 items-center justify-center cursor-pointer pr-4' onClick={() => { setShowMoveModal(true); setSelectionMode(false) }}><MoveIcon className='w-6 h-6'/> Move</button>
            )}
            {selectionMode && hasSelections && (
              <button className='flex gap-1 items-center justify-center cursor-pointer pr-4' onClick={() => {setShowDeleteConfirm(true); setSelectionMode(false)}}><TrashIcon className='w-5 h-5'/>Delete</button>
            )}
            <button className='text-red-500 cursor-pointer' onClick={toggleSelectionMode}>Cancel</button>

          </div> 
        </div>
      )}

      {showDeleteConfirm && (
        <div className='fixed z-50 bottom-16 right-1/2 translate-x-1/2 flex flex-col items-start justify-center px-4 pt-2 pb-4 gap-4 bg-orange rounded-2xl'>
          <p className=''>You are about to permanently delete all the selected items.</p>
          <p className=''>Are you sure?</p>
          <div className='flex items-center justify-between w-full'>
            <button className='text-red-500 cursor-pointer' onClick={() => {setShowDeleteConfirm(false)}}>Cancel</button>
            <button className='cursor-pointer'onClick={() => {handleDelete(); setShowDeleteConfirm(false)}}>Yes</button>
          </div>
        </div>
      )}

      {/*TOASTS*/}
      {toasts.length > 0 && (
        <div className='fixed z-50 bottom-0 left-0 p-8 flex flex-col-reverse w-full max-w-150 text-sm gap-4'>
          {toasts.map(toast => (
            <div
              key={toast.id}
              className="flex items-center justify-between w-full h-24 p-8 bg-[#ffffff] rounded-2xl"
            >
              <p>{toast.message}</p>
              <button
                className="p-4 cursor-pointer"
                onClick={() => removeToast(toast.id)}
              >
                x
              </button>
            </div>
          ))}

        </div>
      )}
      
      {/*FOLDERS AND FILES*/}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))]
                      sm:grid-cols-[repeat(auto-fill,minmax(128px,1fr))]
                      gap-1 w-full">

        {folders.map(folder => (
          <div
            onClick={() => handleFolderClick(folder)}
            key={folder.id}
            className={`relative justify-self-center rounded-sm w-full aspect-square cursor-pointer hover:opacity-80 transition-opacity overflow-hidden bg-orange
              ${ selectedFolders.has(folder.id) ? 'ring-4 ring-cyan-400' : '' }
            `}>

            <FolderIcon className="w-full h-full text-dark-orange" preserveAspectRatio="none" />

            <span style={{display: '-webkit-box'}}
              className="absolute top-14 left-2 right-2 px-3 wrap-break-word overflow-hidden block line-clamp-2 text-black text-start">
              {folder.name}
            </span>
          </div>
        ))}


        {files.map(file => (
          <div
            key={file.id}
            onClick={() => handleFileClick(file)}
            className={`justify-self-center rounded-sm w-full aspect-square cursor-pointer hover:opacity-80 transition-opacity overflow-hidden ${
              selectedFiles.has(file.id) ? 'ring-4 ring-cyan-400' : ''
            }`}
          >
            {file.mime_type.startsWith('image/')
            ? <ThumbnailImage fileId={file.id} alt={file.original_filename} />
            : file.mime_type.startsWith('video/')
            ? <div className="bg-black w-full h-full flex items-center justify-center">
                <VideoIcon className="w-10 h-10 text-white opacity-70" />
              </div>
            : <div className="bg-[#ffffff] p-4 w-full h-full flex items-end justify-start">
                <span className="truncate w-full">{file.original_filename}</span>
              </div>
          }
          </div>
        ))}
        {folders.length === 0 && files.length === 0 &&(
          <p className='text-black text-start col-span-2'>This folder is empty :(</p>
        )}
        
      </div>


      {previewIndex !== null && (
        <PreviewModal
          files={files}
          startIndex={previewIndex}
          onClose={() => setPreviewIndex(null)}
          onDelete={handlePreviewDelete}
        />
      )}


    {/*MOVE MODAL*/}

    {showMoveModal && (
      <MoveModal
        selectedFolders={selectedFolders}
        selectedFiles={selectedFiles}
        setShowMoveModal={setShowMoveModal} 
        folderId= {folderId}        
        setSelectedFolders={setSelectedFolders}
        setSelectedFiles={setSelectedFiles}
        setSelectionMode={setSelectionMode}
        loadFolder={loadFolder}
        addToast={addToast} />
    )}

    </main>
  )
}