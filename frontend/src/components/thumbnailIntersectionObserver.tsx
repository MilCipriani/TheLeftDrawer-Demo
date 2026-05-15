import { useState, useEffect, useRef } from 'react'

import { fetchWithAuth } from '../api/fetchWithAuth' //intercepts 403s to refresh tokens

export default function ThumbnailImage({ fileId, alt }: { fileId: string; alt: string }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const blobUrlRef = useRef<string | null>(null)

  //1) watch the container, set visible when it enters viewport
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect() //stop watching once seen, no need to re-trigger
        }
      },
      { rootMargin: '200px' } //start loading 200px before it scrolls into view
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  //2) only fetch when visible
  useEffect(() => {
    if (!isVisible) return

    let cancelled = false

    fetchWithAuth(`/api/files/${fileId}/thumbnail`)
      .then(res => {
        if (!res.ok) throw new Error('Failed to load thumbnail')
        return res.blob()
      })
      .then(blob => {
        if (cancelled) return
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        setBlobUrl(url)
      })
      .catch(err => console.error('Thumbnail load error:', err))

    //cleanup, revoke blob URL when component unmounts or fileId changes
    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [isVisible, fileId])

  return (
    <div ref={containerRef} className="w-full h-full">
      {blobUrl
        ? <img src={blobUrl} alt={alt} className="w-full h-full object-cover" />
        : <div className="w-full h-full bg-gray-200 animate-pulse" />
      }
    </div>
  )
}