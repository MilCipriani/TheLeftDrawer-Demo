import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchWithAuth } from '../api/fetchWithAuth'

//packages to safely render md files
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'

import ArrowL from '../assets/icons/arrowL.svg?react'
import ArrowR from '../assets/icons/arrowR.svg?react'
import Trash from '../assets/icons/trash.svg?react'
import Download from '../assets/icons/downloadIcon.svg?react'

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
  deleted: boolean
}

interface PreviewModalProps {
  onError?: (message: string) => void
  files: NasFile[]
  currentIndex: number
  onClose: () => void
  onDelete: (fileId: string) => void
  onNavigate: (index: number) => void
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string }

function getFileCategory(mimeType: string): 'image' | 'video' | 'pdf' | 'text' | 'markdown' | 'unsupported' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'markdown'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text'
  return 'unsupported'
}

export default function PreviewModal({
  files,
  currentIndex,
  onClose,
  onDelete,
  onNavigate,
  onError
}: PreviewModalProps) {
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' })
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [holding, setHolding] = useState(false)
  const [tooltip, setTooltip] = useState(false)

  const blobUrlRef = useRef<string | null>(null)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [downloading, setDownloading] = useState(false)

  // May be undefined for a render; do NOT return early until all hooks have run
  const currentFile = files[currentIndex]
  const fileId = currentFile?.id
  const mimeType = currentFile?.mime_type
  const category = mimeType ? getFileCategory(mimeType) : null

  // Load content whenever the file changes
  useEffect(() => {
    if (!fileId || !category) return

    let cancelled = false

    const load = async () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }

      setBlobUrl(null)
      setTextContent(null)
      setPreviewState({ status: 'loading' })

      const contentUrl = `/api/files/${fileId}`

      try {
        if (category === 'image' || category === 'video' || category === 'pdf') {
          const res = await fetchWithAuth(contentUrl)
          if (!res.ok) throw new Error('Failed to load file')
          const blob = await res.blob()
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          setBlobUrl(url)
        } else if (category === 'text' || category === 'markdown') {
          const res = await fetchWithAuth(contentUrl)
          if (!res.ok) throw new Error('Failed to load file')
          const text = await res.text()
          if (cancelled) return
          setTextContent(text)
        }
        if (!cancelled) setPreviewState({ status: 'ready' })
      } catch (err) {
        if (!cancelled) setPreviewState({ status: 'error', message: (err as Error).message })
      }
    }

    load()
    return () => { cancelled = true }
  }, [fileId, category])

  // Cleanup on unmount (blob URL + timers) — merged into one effect
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
      clearTimeout(tooltipTimeoutRef.current)
      clearTimeout(deleteTimerRef.current)
    }
  }, [])

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowRight') onNavigate(Math.min(currentIndex + 1, files.length - 1))
    else if (e.key === 'ArrowLeft') onNavigate(Math.max(currentIndex - 1, 0))
  }, [currentIndex, files.length, onClose, onNavigate])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const handleDelete = async () => {
    if (!fileId) return
    try {
      const res = await fetchWithAuth('/api/softdelete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: [fileId], folderIds: [] })
      })
      if (!res.ok) throw new Error('Delete failed')
      onDelete(fileId)
    } catch (err) {
      console.error(err)
      onError?.('Failed to delete file')
    }
  }

  const handleDeleteHoldStart = () => {
    setHolding(true)
    deleteTimerRef.current = setTimeout(() => {
      setHolding(false)
      handleDelete()
    }, 1500)
  }

  const handleDeleteHoldEnd = () => {
    setHolding(false)
    clearTimeout(deleteTimerRef.current)
    deleteTimerRef.current = undefined
  }

  const triggerDownload = (url: string, filename: string) => {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const handleDownload = async () => {
    if (!currentFile || downloading) return

    // Already in memory (image/video/pdf)
    if (blobUrl) {
      triggerDownload(blobUrl, currentFile.original_filename)
      return
    }

    setDownloading(true)
    try {
      const res = await fetchWithAuth(`/api/files/${currentFile.id}/download`)
      if (!res.ok) throw new Error('Download failed')
      const url = URL.createObjectURL(await res.blob())
      triggerDownload(url, currentFile.original_filename)
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch (err) {
      console.error(err)
      onError?.('Download failed')
    } finally {
      setDownloading(false)
    }
  }

  const showTooltip = () => {
    setTooltip(true)
    clearTimeout(tooltipTimeoutRef.current)
    tooltipTimeoutRef.current = setTimeout(() => setTooltip(false), 2000)
  }

  // All hooks have run — now it's safe to bail out
  if (!currentFile || !category) return null

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center"
      onClick={onClose}
    >
      {/*Modal container tp stop propagation so clicking inside doesn't close*/}
      <div
        className="relative flex flex-col items-center w-full h-full bg-black"
        onClick={e => e.stopPropagation()}
      >

        {/*HEADER*/}
        <div className={`${category === 'pdf' ? 'bottom-18' : 'top-4'} w-fit fixed left-1/2 -translate-x-1/2 flex items-center justify-between gap-2 px-3 rounded-4xl bg-orange shadow-2xl`}>
          <div className="flex items-center gap-3">
            {/*Delete*/}
            <button 
              onClick={showTooltip}
              onPointerDown={handleDeleteHoldStart}
              onPointerUp={handleDeleteHoldEnd}
              onPointerLeave={handleDeleteHoldEnd}
              onPointerCancel={handleDeleteHoldEnd}
              onContextMenu={e => e.preventDefault()}
              className='relative cursor-pointer select-none touch-none'
            >
              <Trash className='w-6 h-6 text-black'/>
              <Trash
                className={`w-6 h-6 text-red-500 absolute inset-0 transition-none ${holding ? 'animate-fill-up' : ''}`}
                style={{ clipPath: holding ? undefined : 'inset(100% 0 0 0)' }}
              />
            </button>
            {tooltip && (
              <span className='fixed top-11 left-0 z-50 px-2 rounded-2xl bg-white text-black'>Hold</span>
            )}

            {/*Download*/}
            <button
              onClick={e => { e.stopPropagation(); handleDownload() }}
              className="cursor-pointer py-2"
            ><Download className='text-black w-6 h-6'/></button>
            <button
              onClick={onClose}
              className="cursor-pointer text-black text-xl leading-none transition-colors w-7 h-8 flex items-center justify-center rounded-lg hover:bg-white/10"
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
                (() => {
                  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
                  if (isMobile) {
                    return (
                      <div className="flex flex-col items-center gap-4 text-white/60">
                        <p className="text-lg">PDF preview isn't supported on mobile yet</p>
                        <p >Please download the file to view it</p>
                      </div>
                    )
                  }
                  return (
                    <iframe
                      key={currentFile.id}
                      src={blobUrl}
                      title={currentFile.original_filename}
                      className="w-screen h-screen"
                    />
                  )
                })()
              )}

              {category === 'markdown' && textContent !== null && (
                <div className="w-screen h-full overflow-y-auto overflow-x-hidden p-6 bg-gray-900 text-white text-sm wrap-break-word">
                  <article className="prose prose-invert max-w-none">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeRaw, rehypeSanitize]} // order matters: sanitize AFTER raw
                      components={{
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        a: ({ node, ...props }) => (
                          <a {...props} target="_blank" rel="noopener noreferrer" />
                        ),
                      }}
                    >
                      {textContent}
                    </ReactMarkdown>
                  </article>
                </div>
              )}

              {category === 'text' && textContent !== null && (
                <pre className="w-screen h-full overflow-auto p-6 bg-gray-900 text-white text-sm whitespace-pre-wrap wrap-break-word">{textContent}</pre>
              )}

              {category === 'unsupported' && (
                <div className="flex flex-col items-center gap-4 text-white/60">
                  <p className="text-lg">Preview not available</p>
                  <p className="text-sm">{currentFile.mime_type}</p>
                  <button
                    onClick={handleDownload}
                    disabled={downloading}
                    className="cursor-pointer bg-white text-black text-sm px-4 py-2 rounded-xl hover:bg-gray-200 transition-colors disabled:opacity-50"
                  >
                    {downloading ? 'Downloading...' : 'Download to view'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/*FOOTER (only when there are multiple files)*/}
        {files.length > 1 && (
          <div className="w-fit fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-between p-1 rounded-4xl bg-orange shadow-2xl">
            <button
              onClick={() => onNavigate(Math.max(currentIndex - 1, 0))}
              disabled={currentIndex === 0}
              className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-20 px-3 py-1"
            >
              <ArrowL className='w-8 h-8 text-black'/>
            </button>
            <span className="text-black">
              {currentIndex + 1} / {files.length}
            </span>
            <button
              onClick={() => onNavigate(Math.min(currentIndex + 1, files.length - 1))}
              disabled={currentIndex === files.length - 1}
              className="cursor-pointer disabled:cursor-not-allowed text-white hover:text-white disabled:opacity-20 transition-colors px-3 py-1 rounded-lg hover:bg-white/10 text-sm"
            >
              <ArrowR className='w-8 h-8 text-black'/>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}