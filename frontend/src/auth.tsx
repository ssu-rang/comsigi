import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { service } from "./service"
import type { Session } from "./domain"
import { ErrorNotice, Loading } from "./ui"
import { Link, navigate } from "./router"

type Auth = {
  session: Session | null
  loading: boolean
  error: unknown
  expired: boolean
  refresh: () => void
  login: (u: string, p: string) => Promise<void>
  logout: () => Promise<void>
}
const Context = createContext<Auth>(null!)
export const useAuth = () => useContext(Context)
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null),
    [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null),
    [expired, setExpired] = useState(false),
    [tick, setTick] = useState(0)
  useEffect(() => {
    let active = true
    setLoading(true)
    service
      .session()
      .then((next) => {
        if (active) {
          setSession(next)
          setError(null)
        }
      })
      .catch((e) => {
        if (active) setError(e)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [tick])
  useEffect(() => {
    const expire = () => {
      setSession(null)
      setExpired(true)
    }
    window.addEventListener("auth-expired", expire)
    const timer = session
      ? setTimeout(
          expire,
          Math.max(0, Date.parse(session.expiresAt) - Date.now()),
        )
      : undefined
    return () => {
      window.removeEventListener("auth-expired", expire)
      clearTimeout(timer)
    }
  }, [session])
  return (
    <Context.Provider
      value={{
        session,
        loading,
        error,
        expired,
        refresh: () => setTick((n) => n + 1),
        login: async (u, p) => {
          const next = await service.login(u, p)
          if (next.role !== "admin") throw new Error("관리자 권한이 없습니다.")
          setSession(next)
          setExpired(false)
          setError(null)
        },
        logout: async () => {
          try {
            await service.logout()
          } finally {
            setSession(null)
            setExpired(false)
            navigate("/admin/login")
          }
        },
      }}
    >
      {children}
    </Context.Provider>
  )
}
export function AdminGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  if (auth.loading) return <Loading label="관리자 인증을 확인하고 있습니다" />
  if (auth.error) return <ErrorNotice error={auth.error} retry={auth.refresh} />
  return auth.session?.role === "admin" ? children : <Login inline />
}
export function Login({ inline = false }: { inline?: boolean }) {
  const auth = useAuth()
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false)
  if (auth.session && !inline)
    return (
      <section className="login-panel">
        <h1>관리자 로그인</h1>
        <p>{auth.session.name}님, 로그인되어 있습니다.</p>
        <Link className="primary-button" to="/admin/places">
          공간 관리로 이동
        </Link>
      </section>
    )
  return (
    <section className="login-panel">
      <h1>관리자 로그인</h1>
      {auth.expired && (
        <p className="notice" role="status">
          인증이 만료되었습니다. 다시 로그인하면 편집 초안을 이어갈 수 있습니다.
        </p>
      )}
      {service.mode === "unconfigured" && (
        <p className="notice">관리자 로그인 연결을 준비하고 있습니다.</p>
      )}
      {import.meta.env.DEV && service.mode === "development" && (
        <p className="notice">개발 전용 계정: admin / dev-only</p>
      )}
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (busy) return
          const form = new FormData(e.currentTarget)
          setBusy(true)
          setError(null)
          try {
            await auth.login(
              String(form.get("username")),
              String(form.get("password")),
            )
            if (!inline) navigate("/admin/places")
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="field">
          관리자 이름
          <input
            name="username"
            autoComplete="username"
            required
            disabled={busy}
          />
        </label>
        <label className="field">
          비밀번호
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </label>
        <ErrorNotice error={error} />
        <button
          className="primary-button"
          disabled={busy || service.mode === "unconfigured"}
        >
          {busy ? "로그인 중…" : "로그인"}
        </button>
      </form>
      <Link className="inline-link" to="/">
        좌석 현황으로 돌아가기
      </Link>
    </section>
  )
}
