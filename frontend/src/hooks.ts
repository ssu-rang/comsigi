import { useCallback, useEffect, useRef, useState } from "react"
import type { Id } from "./domain"
import type { LinkState } from "./domain"
import { initialLive, applyEvent } from "./realtime"
import { service } from "./service"

export function useResource<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  keys: unknown[] = [],
) {
  const [state, setState] = useState<{
    data: T | null
    error: unknown
    loading: boolean
  }>({ data: null, error: null, loading: true })
  const [revision, setRevision] = useState(0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const reload = useCallback(() => setRevision((n) => n + 1), [])
  useEffect(() => {
    const controller = new AbortController()
    setState({ data: null, error: null, loading: true })
    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ data, error: null, loading: false })
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setState({ data: null, error, loading: false })
      })
    return () => controller.abort()
  }, [...keys, revision])
  return { ...state, reload }
}

export function useLive(
  placeId: Id,
  onLayout: () => void,
  layoutRevision?: number,
) {
  const [live, setLive] = useState(initialLive)
  const [connection, setConnection] = useState<LinkState>("connecting")
  const [retry, setRetry] = useState(0)
  const [deleted, setDeleted] = useState(false)
  const [now, setNow] = useState(Date.now)
  const callback = useRef(onLayout)
  callback.current = onLayout
  const knownRevision = useRef(-1)
  useEffect(() => {
    // A reconnect may have missed layout_updated. The snapshot revision is also
    // authoritative; compare it after REST resolves, regardless of arrival order.
    if (
      !live.layout &&
      layoutRevision !== undefined &&
      live.revision > layoutRevision
    )
      callback.current()
  }, [layoutRevision, live.revision])
  useEffect(() => {
    let disposed = false,
      stop: (() => void) | undefined
    let current = initialLive()
    knownRevision.current = -1
    setLive(current)
    setDeleted(false)
    setConnection("connecting")
    const timer = setTimeout(() => {
      stop = service.subscribe(placeId, {
        connection: (state) => {
          if (!disposed) setConnection(state)
        },
        event: (event) => {
          if (disposed || event.placeId !== placeId) return
          if (event.type === "place_deleted") {
            setDeleted(true)
            setConnection("offline")
            return
          }
          if (event.type === "layout_updated") {
            if (event.revision > knownRevision.current) {
              knownRevision.current = event.revision
              callback.current()
            }
            return
          }
          const result = applyEvent(current, event)
          current = result.state
          if (result.resync) {
            setConnection("syncing")
            setRetry((n) => n + 1)
            return
          }
          setLive(current)
          setNow(Date.now())
          if (event.type === "snapshot") {
            if (
              knownRevision.current >= 0 &&
              event.revision > knownRevision.current
            )
              callback.current()
            knownRevision.current = event.revision
          }
        },
      })
    }, 0)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearInterval(clock)
      stop?.()
    }
  }, [placeId, retry])
  return {
    live,
    connection,
    deleted,
    now,
    reconnect: () => setRetry((n) => n + 1),
  }
}

export const notifyDataChanged = () =>
  window.dispatchEvent(new Event("data-changed"))
export function useDataRefresh(reload: () => void) {
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") reload()
    }
    window.addEventListener("data-changed", reload)
    window.addEventListener("focus", reload)
    document.addEventListener("visibilitychange", visible)
    return () => {
      window.removeEventListener("data-changed", reload)
      window.removeEventListener("focus", reload)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [reload])
}
