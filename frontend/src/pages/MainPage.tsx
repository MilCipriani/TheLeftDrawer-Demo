import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

import { fetchWithAuth } from '../api/fetchWithAuth' //intercepts 403s to refresh tokens

import Logo from '../assets/transpLogoWhite.svg?react'
import MenuIcon from '../assets/icons/MenuIcon.svg?react'
import FolderIcon from '../assets/icons/FolderIcon.svg?react'
import PreviewModal from '../components/PreviewModal'
import ThumbnailImage from '../components/thumbnailIntersectionObserver' //lazy loading for thumbnails

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
  const [allFolders, setAllFolders] = useState<Folder[]>([])
  const [movingTo, setMovingTo] = useState<number | null>(null)
  const [loadingFolders, setLoadingFolders] = useState(false)

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

  if (loading) return <p className='text-sm text-white'>Loading...</p>

  //make Toast (for errors and deleted message)
  const addToast = (message: string) => {
    const id = Date.now(); //unique id
    setToasts(prev => [...prev, { id, message }]);
  };

  //remove Toast
  const removeToast = (id: number) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

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

      const data = await res.json();
      console.log("Uploaded:", data.files);
      loadFolder(folderId);
    } catch (err) {
      console.error(err);
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

  //load folders for "move" path picker
  const loadAllFolders = async () => {
    setLoadingFolders(true)
    try {
      const response = await fetchWithAuth('/api/folders/all')
      const data = await response.json()
      setAllFolders(data.folders)
    } catch (err) {
      console.error('Failed to load folders:', err)
    } finally {
      setLoadingFolders(false)
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
      addToast(`Move failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
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

      console.log('Delete successful:', data)
      addToast(`Delete successful: ${data.message}`)

      //clear selections and exit selection mode
      setSelectedFiles(new Set())
      setSelectedFolders(new Set())
      setSelectionMode(false)

      //refresh current folder
      await loadFolder(folderId)

    } catch (error) {
      console.error('Delete error:', error)
      addToast(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)
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
    <main className="h-full w-full flex flex-col items-center justify-start py-16 px-4 sm:px-16 gap-16">

      {/*NAVBAR*/}
      <nav className='w-full flex items-center justify-between'>
        <div className='flex items-center justify-center gap-4 sm:gap-8'>
          <Logo className='main-logo shrink-0 cursor-pointer' onClick={() => navigate(`/${user}`)}/>
          <h1 className='main text-white font-light'>{(currentFolder?.name!== user) ? currentFolder?.name : 'Welcome to your left drawer!'}</h1>
        </div>
        
      </nav>

      {/*DOTS MENU*/}
      {!menuToggler && (
        <button className='z-20 bg-white rounded-full p-4 w-16 aspect-square flex items-center justify-center fixed bottom-16 right-4 sm:right-16 cursor-pointer' onClick={() => setMenuToggler(true)}>
          <MenuIcon className='text-black'/>
        </button>
      )}
      

      {menuToggler && (
        <div className='fixed z-50 bottom-16 right-4 sm:right-16 flex flex-col items-start justify-center px-8 py-4 gap-4 sm:gap-3 bg-white rounded-2xl'>
          <button className='cursor-pointer pr-6'  onClick={() => {setMenuToggler(false); setNewFolderShowModal(true)}}>New folder</button>

          <input type="file" ref={uploadfileInputRef} multiple onChange={(e) => { setMenuToggler(false); handleUpload(e)}} style={{ display: "none" }}/>
          <button className='cursor-pointer pr-6' onClick={() => uploadfileInputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading...' : 'Upload file'}
          </button>

          <button className='cursor-pointer pr-6' onClick={() => {setMenuToggler(false); toggleSelectionMode()}}>Selection</button>
          <hr className='border-gray-300 w-full'></hr>
          <button className='cursor-pointer pr-6' onClick={async () => {await logout(); navigate('/')}}>Logout</button>
          <hr className='border-gray-300 w-full'></hr>
          <button className='text-red-500 cursor-pointer pr-6' onClick={() => setMenuToggler(false)}>Cancel</button>
        </div>
      )}

      {showNewFolderModal && (
        <div className='fixed z-50 bottom-16 right-4 sm:right-16 flex flex-col items-start justify-center px-8 py-4 gap-4 sm:gap-3 bg-white rounded-2xl'>
          <p className=''>How will you name your folder?</p>
          <input 
            type='text' 
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createFolder()}
          />
          {folderError && (
            <p className='text-red-500'>{folderError}</p>
          )}
          <div className='flex items-center justify-between w-full'>
            <button className='text-red-500 cursor-pointer' onClick={() => {setNewFolderShowModal(false); setFolderError('')}}>Cancel</button>
            <button className='cursor-pointer pr-4' onClick={createFolder}>Ok</button>
          </div> 
        </div>
      )}

      {selectionMode && (
        <div className='fixed z-50 bottom-16 right-4 sm:right-16 flex flex-col items-start justify-center px-8 py-4 gap-4 sm:gap-3 bg-white rounded-2xl'>
          <p className=''>{selectionCount>0 ? `${selectionCount} element(s) selected` : 'Select your files and folders...'}</p>
          <div className='flex items-center justify-around w-full'>
            {selectionMode && hasSelections && (
              <button className='cursor-pointer pr-4' onClick={() => { loadAllFolders(); setShowMoveModal(true) }}>Move</button>
            )}
            {selectionMode && hasSelections && (
              <button className='cursor-pointer pr-4' onClick={() => {setShowDeleteConfirm(true); setSelectionMode(false)}}>Delete</button>
            )}
            <button className='text-red-500 cursor-pointer' onClick={toggleSelectionMode}>Cancel</button>

          </div> 
        </div>
      )}

      {showDeleteConfirm && (
        <div className='fixed z-50 bottom-16 right-4 sm:right-16 flex flex-col items-start justify-center px-8 py-4 gap-4 sm:gap-3 bg-white rounded-2xl'>
          <p className=''>You are about to permanently delete all the selected items.</p>
          <p className=''>Are you sure?</p>
          <div className='flex items-center justify-between w-full'>
            <button className='text-red-500 cursor-pointer' onClick={() => {setShowDeleteConfirm(false); setSelectionMode(true)}}>Cancel</button>
            <button className='cursor-pointer'onClick={() => {handleDelete(); setShowDeleteConfirm(false)}}>Yes</button>
          </div>
        </div>
      )}

      {/*TOASTS*/}
      <div className='fixed bottom-0 left-0 p-8 flex flex-col-reverse w-full max-w-150 text-sm gap-4'>
        {toasts.map(toast => (
          <div
            key={toast.id}
            className="flex items-center justify-between w-full h-24 p-8 bg-white rounded-2xl"
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
      {/*FOLDERS AND FILES*/}
      <div className="grid
                      grid-cols-[repeat(auto-fill,minmax(104px,1fr))]
                      sm:grid-cols-[repeat(auto-fill,minmax(128px,1fr))]
                      gap-1
                      w-full">


        {folders.map(folder => (
          <div
            onClick={() => handleFolderClick(folder)}
            key={folder.id}
            className={`relative justify-self-center rounded-[2.5rem] sm:rounded-[3rem] w-full aspect-square cursor-pointer hover:opacity-80 transition-opacity overflow-hidden ${
              selectedFolders.has(folder.id) ? 'ring-4 ring-blue-500' : ''
            }`}>

            <FolderIcon className="w-full h-full" preserveAspectRatio="none" />

            <span style={{display: '-webkit-box'}}
              className="absolute top-14 left-2 right-2 wrap-break-word overflow-hidden block line-clamp-2 text-white text-start">
              {folder.name}
            </span>
          </div>
        ))}


        {files.map(file => (
          <div
            key={file.id}
            onClick={() => handleFileClick(file)}
            className={`justify-self-center rounded-[2.5rem] sm:rounded-[3rem] w-full aspect-square cursor-pointer hover:opacity-80 transition-opacity overflow-hidden ${
              selectedFiles.has(file.id) ? 'ring-4 ring-blue-500' : ''
            }`}
          >
            {file.mime_type.startsWith('image/')
              ? <ThumbnailImage fileId={file.id} alt={file.original_filename} />
              : <div className="bg-white p-4 w-full h-full flex items-end justify-start">
                  <span className="truncate w-full">{file.original_filename}</span>
                </div>
            }
          </div>
        ))}
        {folders.length === 0 && files.length === 0 &&(
          <p className='text-white text-start col-span-2'>This folder is empty :(</p>
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

      {showMoveModal && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm p-4 text-white overflow-hidden" onClick={() => setShowMoveModal(false)}>
          <div className="w-full h-full flex flex-col gap-16 p-2 items-center justify-center bg-black rounded-2xl shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2>Move to...</h2>
            {loadingFolders ? (
              <p className='text-white font-light'>Loading folders...</p>
            ) : (
              <ul className="overflow-auto w-full max-w-200 min-h-0 flex-1 max-h-96 flex flex-col gap-1">
                {allFolders
                  //don't show the currently selected folders as destinations
                  .filter(f => !Array.from(selectedFolders).includes(f.id))
                  //don't show the current folder
                  .filter(f => f.id !== currentFolder?.id)
                  .map(f => (
                    <li
                      key={f.id}
                      className={`rounded-xl p-2 cursor-pointer ${movingTo === f.id ? 'bg-white text-black' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`}
                      onClick={() => setMovingTo(f.id)}
                    >
                      {f.path}
                    </li>
                  ))}
              </ul>
            )}
            <div className="flex gap-8">
              <button onClick={() => setShowMoveModal(false)} className='p-4 cursor-pointer text-sm px-4 py-2 rounded-xl transition-colors bg-blue-500 text-white hover:bg-blue-600'>Cancel</button>
              <button onClick={handleMove} disabled={!movingTo} className='p-4 cursor-pointer text-sm px-4 py-2 rounded-xl transition-colors bg-red-500 text-white hover:bg-red-600'>
                Move here
              </button>
            </div>
          </div>
        </div>
      )}

    </main>
  )
}