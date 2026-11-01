import {
  useEffect,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
} from "react"

let guard: (() => boolean) | null = null
let current = location.hash.slice(1) || "/"
const listeners = new Set<() => void>()
function changed() {
  for (const listener of listeners) listener()
}
window.addEventListener("hashchange", () => {
  const next = location.hash.slice(1) || "/"
  if (next === current) return
  if (guard && !guard()) {
    history.replaceState(null, "", `#${current}`)
    return
  }
  current = next
  changed()
  window.scrollTo(0, 0)
})
export function navigate(to: string, replace = false) {
  if (to === current || (guard && !guard())) return
  current = to
  if (replace) history.replaceState(null, "", `#${to}`)
  else history.pushState(null, "", `#${to}`)
  changed()
  window.scrollTo(0, 0)
}
export function useRoute() {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    () => current,
  )
}
export function Link({
  to,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...props}
      href={`#${to}`}
      onClick={(e) => {
        onClick?.(e)
        if (
          !e.defaultPrevented &&
          e.button === 0 &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.shiftKey &&
          !e.altKey
        ) {
          e.preventDefault()
          navigate(to)
        }
      }}
    />
  )
}
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const check = () =>
      window.confirm(
        "저장하지 않은 변경사항이 있습니다. 이 페이지를 나가시겠습니까? 편집 초안은 이 탭에 보관됩니다.",
      )
    guard = check
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", unload)
    return () => {
      if (guard === check) guard = null
      window.removeEventListener("beforeunload", unload)
    }
  }, [dirty])
}
