import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { fetchWithAuth } from '../api/fetchWithAuth'

import ArrowL from '../assets/icons/arrowL.svg?react'
import ArrowR from '../assets/icons/arrowR.svg?react'
import Trash from '../assets/icons/trash.svg?react'

interface NasFile {
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

interface PreviewModalProps {
  files: NasFile[]
  startIndex: number
  onClose: () => void
  onDelete: (fileId: string) => void
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

function getFileCategory(mimeType: string): 'image' | 'video' | 'pdf' | 'text' | 'unsupported' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text'
  return 'unsupported'
}

export default function PreviewModal({ files, startIndex, onClose, onDelete }: PreviewModalProps) {
  const { token } = useAuth()
  const [currentIndex, setCurrentIndex] = useState(startIndex)
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' })

  //Blob URL for image/video/pdf (requires auth header so src is no use)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  //for text files
  const [textContent, setTextContent] = useState<string | null>(null)

  //timer for delete holding the trash button
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  //state for icon animation for delete on-hold
  const [holding, setHolding] = useState(false)

  const currentFile = files[currentIndex]
  const category = getFileCategory(currentFile.mime_type)

  const downloadUrl = `/api/files/${currentFile.id}/download`

  //reset and load content whenever the file changes
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      //revoke previous blob URL
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }

      //all state resets happen inside the async function, not synchronously in the effect body
      setBlobUrl(null)
      setTextContent(null)
      setPreviewState({ status: 'loading' })

      const contentUrl = `/api/files/${currentFile.id}`

      try {
        if (category === 'image' || category === 'video' || category === 'pdf') {
          const res = await fetchWithAuth(contentUrl)
          if (!res.ok) throw new Error('Failed to load file')
          const blob = await res.blob()
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setBlobUrl(url)
          setPreviewState({ status: 'ready' })

        } else if (category === 'text') {
          const res = await fetchWithAuth(contentUrl)
          if (!res.ok) throw new Error('Failed to load file')
          const text = await res.text()
          if (cancelled) return
          setTextContent(text)
          setPreviewState({ status: 'ready' })

        } else {
          setPreviewState({ status: 'ready' })
        }
      } catch (err) {
        if (!cancelled) setPreviewState({ status: 'error', message: (err as Error).message })
      }
    }

    load()
    return () => { cancelled = true }
  }, [currentIndex, category, currentFile.id, token])

  //cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [])

  //keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight') setCurrentIndex(i => Math.min(i + 1, files.length - 1))
      if (e.key === 'ArrowLeft') setCurrentIndex(i => Math.max(i - 1, 0))
    },
    [files.length, onClose]
  )

  //delete holding the button
  const handleDeleteHoldStart = () => {
    setHolding(true)
    deleteTimerRef.current = setTimeout(() => {
      setHolding(false)
      handleDelete()
    }, 2000)
  }

  const handleDeleteHoldEnd = () => {
    setHolding(false)
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = null
    }
  }

  const handleDelete = async () => {
    try {
      const res = await fetchWithAuth(`/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: [currentFile.id], folderIds: [] })
      })
      if (!res.ok) throw new Error('Delete failed')
      onDelete(currentFile.id)
    } catch (err) {
      console.error(err)
    }
  }

  const handleDownload = () => {
    //reuse the blob that's already in memory
    const url = blobUrl ?? (() => {
      //fallback for unsupported types that never got a blobUrl
      console.warn('No blob URL available for download')
      return null
    })()

    if (!url) return

    const a = document.createElement('a')
    a.href = url
    a.download = currentFile.original_filename
    a.click()
  }

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      {/*Modal container tp stop propagation so clicking inside doesn't close*/}
      <div
        className="relative flex flex-col w-full h-full p-2 bg-black rounded-2xl overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
      >

        {/*HEADER*/}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-b border-white/10 shrink-0">
          <span className="text-white truncate max-w-[60%]">
            {currentFile.original_filename}
          </span>
          <div className="flex items-center gap-3">
            <button 
              onPointerDown={handleDeleteHoldStart}
              onPointerUp={handleDeleteHoldEnd}
              onPointerLeave={handleDeleteHoldEnd}
              className='relative cursor-pointer'
            >
              <Trash className='w-8 h-8 text-white'/>
              <Trash
                className={`w-8 h-8 text-red-500 absolute inset-0 transition-none ${holding ? 'animate-fill-up' : ''}`}
                style={{ clipPath: holding ? undefined : 'inset(100% 0 0 0)' }}
              />
            </button>
            <button
              onClick={e => { e.stopPropagation(); handleDownload() }}
              className="cursor-pointer bg-white text-black text-sm px-4 py-2 rounded-xl hover:bg-gray-200 transition-colors"
            >
              Download
            </button>
            <button
              onClick={onClose}
              className="cursor-pointer text-white hover:text-white text-xl leading-none transition-colors w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10"
            >
              ✕
            </button>
          </div>
        </div>

        {/*PREVIEW AREA*/}
        <div className="flex-1 overflow-auto flex items-center justify-center min-h-0">
          {previewState.status === 'loading' && (
            <p className="text-white/50 text-sm">Loading...</p>
          )}

          {previewState.status === 'error' && (
            <p className="text-red-400 text-sm">{previewState.message}</p>
          )}

          {previewState.status === 'ready' && (
            <>
              {category === 'image' && blobUrl && (
                <img
                  key={currentFile.id}
                  src={blobUrl}
                  alt={currentFile.original_filename}
                  className="max-w-full max-h-full object-contain"
                />
              )}

              {category === 'video' && blobUrl && (
                <video
                  key={currentFile.id}
                  controls
                  autoPlay
                  className="max-w-full max-h-full"
                >
                  <source src={blobUrl} type={currentFile.mime_type} />
                </video>
              )}

              {category === 'pdf' && blobUrl && (
                <iframe
                  key={currentFile.id}
                  src={blobUrl}
                  title={currentFile.original_filename}
                  className="w-full h-full min-h-[70vh]"
                />
              )}

              {category === 'text' && textContent !== null && (
                <pre className="w-full h-full overflow-auto text-sm text-green-300 bg-gray-900 p-6 whitespace-pre-wrap wrap-break-word font-mono">
                  {textContent}
                </pre>
              )}

              {category === 'unsupported' && (
                <div className="flex flex-col items-center gap-4 text-white/60">
                  <p className="text-lg">Preview not available</p>
                  <p className="text-sm">{currentFile.mime_type}</p>
                  <a
                    href={downloadUrl}
                    download={currentFile.original_filename}
                    className="bg-white text-black text-sm px-4 py-2 rounded-xl hover:bg-gray-200 transition-colors"
                  >
                    Download to view
                  </a>
                </div>
              )}
            </>
          )}
        </div>

        {/*FOOTER (only when there are multiple files)*/}
        {files.length > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-white/10 shrink-0">
            <button
              onClick={() => setCurrentIndex(i => Math.max(i - 1, 0))}
              disabled={currentIndex === 0}
              className="cursor-pointer disabled:cursor-not-allowed text-white hover:text-white disabled:opacity-20 transition-colors px-3 py-1 rounded-lg hover:bg-white/10 text-sm"
            >
              <ArrowL className='w-8 h-8'/>
            </button>
            <span className="text-white text-sm">
              {currentIndex + 1} / {files.length}
            </span>
            <button
              onClick={() => setCurrentIndex(i => Math.min(i + 1, files.length - 1))}
              disabled={currentIndex === files.length - 1}
              className="cursor-pointer disabled:cursor-not-allowed text-white hover:text-white disabled:opacity-20 transition-colors px-3 py-1 rounded-lg hover:bg-white/10 text-sm"
            >
              <ArrowR className='w-8 h-8'/>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}