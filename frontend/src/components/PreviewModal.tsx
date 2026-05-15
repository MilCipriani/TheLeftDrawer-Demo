import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { fetchWithAuth } from '../api/fetchWithAuth'

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

function getFileCategory(mimeType: string): 'image' | 'video' | 'pdf' | 'text' | 'markdown' | 'unsupported' {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf') return 'pdf'
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'markdown'
  if (mimeType.startsWith('text/') || mimeType === 'application/json') return 'text'
  return 'unsupported'
}

type Segment =
  | { type: 'code'; lang: string; content: string }
  | { type: 'text'; content: string }

function renderMarkdown(md: string): string {
  const segments: Segment[] = []

  const fenceRegex = /^```(\w*)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm
  let lastIndex = 0
  let match

  while ((match = fenceRegex.exec(md)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: md.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'code', lang: match[1] || 'plain', content: match[2] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < md.length) {
    segments.push({ type: 'text', content: md.slice(lastIndex) })
  }

  return segments.map(seg => {
    if (seg.type === 'code') {
      const escaped = seg.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      return `<div style="width:100%;margin:1rem 0;border-radius:8px;overflow:hidden">
        ${seg.lang && seg.lang !== 'plain' ? `<div style="background:#1a1a2e;padding:4px 12px;font-size:0.7rem;color:#888">${seg.lang}</div>` : ''}
        <div style="background:#0d0d0d;overflow-x:auto;-webkit-overflow-scrolling:touch">
          <pre style="padding:16px;margin:0;white-space:pre;color:#d4d4d4;font-size:0.8rem;font-family:monospace;display:inline-block;min-width:100%">${escaped}</pre>
        </div>
      </div>`
    }

    return seg.content
      .split('\n')
      .map(line => {
        //pass raw HTML through (e.g. <p align="center">...</p>)
        if (/^\s*<[a-zA-Z]/.test(line)) return line

        if (/^### /.test(line)) return `<h3 style="font-size:1.1rem;font-weight:700;margin:1rem 0 0.25rem">${line.slice(4)}</h3>`
        if (/^## /.test(line))  return `<h2 style="font-size:1.6rem;font-weight:700;margin:1.25rem 0 0.25rem">${line.slice(3)}</h2>`
        if (/^# /.test(line))   return `<h1 style="font-size:1.8rem;font-weight:700;margin:1.5rem 0 0.5rem">${line.slice(2)}</h1>`
        if (/^> /.test(line))   return `<blockquote style="border-left:3px solid #555;padding-left:12px;color:#aaa;font-style:italic;margin:0.5rem 0">${line.slice(2)}</blockquote>`
        if (/^- /.test(line))   return `<li style="margin-left:1.25rem;list-style-type:disc;margin-bottom:0.15rem">${applyInline(line.slice(2))}</li>`
        if (/^\t- /.test(line)) return `<li style="margin-left:2.5rem;list-style-type:circle;margin-bottom:0.15rem">${applyInline(line.slice(3))}</li>`

        if (line.trim() === '') return '<br/>'
        return `<p style="margin-bottom:0.25rem">${applyInline(line)}</p>`
      })
      .join('\n')
  }).join('\n')
}

function applyInline(line: string): string {
  //escape HTML first, but preserve already-escaped entities
  let out = line
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  //links: [text](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" style="color:#60a5fa;text-decoration:underline" target="_blank" rel="noopener noreferrer">$1</a>'
  )

  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*(.+?)\*/g,     '<em>$1</em>')
  out = out.replace(/`([^`]+)`/g,     '<code style="background:#374151;padding:1px 5px;border-radius:4px;font-size:0.85em;font-family:monospace">$1</code>')

  return out
}

export default function PreviewModal({ files, startIndex, onClose, onDelete }: PreviewModalProps) {
  const { token } = useAuth()
  const [currentIndex, setCurrentIndex] = useState<number>(startIndex)
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' })

  //Blob URL for image/video/pdf (requires auth header so src is no use)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  //for text files
  const [textContent, setTextContent] = useState<string | null>(null)

  //timer for delete holding the trash button
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  //state for icon animation for delete on-hold
  const [holding, setHolding] = useState<boolean>(false)
  //delete icon tooltip state
  const [tooltip, setTooltip] = useState<boolean>(false)
  const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

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

        } else if (category === 'text' || category === 'markdown') {
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

useEffect(() => {
  return () => {
    clearTimeout(tooltipTimeoutRef.current)
    clearTimeout(deleteTimerRef.current)
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
    }, 1500)
  }

  const handleDeleteHoldEnd = () => {
    setHolding(false)
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
      deleteTimerRef.current = undefined
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

  const showTooltip = () => {
    setTooltip(true)
    clearTimeout(tooltipTimeoutRef.current)
    tooltipTimeoutRef.current = setTimeout(()=>{
      setTooltip(false)
    }, 2000)
  }


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
              className='relative cursor-pointer'
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
                <div
                  style={{ overflowX: 'hidden', overflowY: 'auto', width: '100vw', height: '100%', padding: '1.5rem', background: '#111827', color: 'white', fontSize: '0.875rem', wordBreak: 'break-word', }}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(textContent) }}
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
          <div className="w-fit fixed bottom-4 left-1/2 -translate-x-1/2 flex items-center justify-between p-1 rounded-4xl bg-orange shadow-2xl">
            <button
              onClick={() => setCurrentIndex(i => Math.max(i - 1, 0))}
              disabled={currentIndex === 0}
              className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-20 px-3 py-1"
            >
              <ArrowL className='w-8 h-8 text-black'/>
            </button>
            <span className="text-black">
              {currentIndex + 1} / {files.length}
            </span>
            <button
              onClick={() => setCurrentIndex(i => Math.min(i + 1, files.length - 1))}
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