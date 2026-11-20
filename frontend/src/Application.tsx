import { lazy, Suspense, useRef, useState } from "react"
import { AuthProvider, AdminGate, Login, useAuth } from "./auth"
import { Link, useRoute } from "./router"
import { Icon, Swatch } from "./ui"
import { STATUS_LABEL } from "./domain"
import { PlaceFinder } from "./PlaceFinder"
import { PlacesAdmin } from "./admin/PlacesAdmin"
import { LayoutEditor } from "./admin/LayoutEditor"
import { DevicesAdmin } from "./admin/DevicesAdmin"
import { PlaceSetup } from "./admin/PlaceSetup"
import "./management.css"

const DevPanel =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_DATA === "true"
    ? lazy(() => import("./dev/DevPanel"))
    : null

export default function App() {
  return (
    <AuthProvider>
      <Application />
    </AuthProvider>
  )
}
function Application() {
  const route = useRoute(),
    auth = useAuth(),
    help = useRef<HTMLDialogElement>(null)
  const [logoutError, setLogoutError] = useState("")
  const admin = route.startsWith("/admin")
  const segments = route.split("/").filter(Boolean)
  const favorite = route === "/favorites"
  const finder =
    route !== "/admin/login" &&
    !admin &&
    (route === "/" || favorite || segments[0] === "places")
  const footer = (
    <>
      {DevPanel && (
        <Suspense fallback={null}>
          <DevPanel />
        </Suspense>
      )}
    </>
  )
  return (
    <div className={`app-shell ${finder ? "is-finder" : ""}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById("main-content")?.focus()
        }}
      >
        본문으로 바로가기
      </a>
      <header className="site-header">
        <div className="header-inner flex items-center justify-between">
          <Link
            className="brand flex items-center gap-2"
            to="/"
            aria-label="빈자리 홈"
          >
            <Icon name="chair" size={25} />
            <span>빈자리</span>
          </Link>
          <nav className="header-nav flex items-center" aria-label="주요 메뉴">
            <Link
              className={`nav-link ${!admin && !favorite ? "active" : ""}`}
              to="/"
            >
              좌석 현황
            </Link>
            <Link
              className={`nav-link ${favorite ? "active" : ""}`}
              to="/favorites"
            >
              즐겨찾기
            </Link>
            <Link
              className={`nav-link ${admin ? "active" : ""}`}
              to="/admin/places"
            >
              관리자
            </Link>
          </nav>
          <button
            className="help-button flex items-center gap-2"
            aria-label="이용 안내"
            onClick={() => help.current?.showModal()}
          >
            <Icon name="info" size={16} />
            <span>이용 안내</span>
          </button>
        </div>
      </header>
      <main
        id="main-content"
        className={`main-container ${
          finder
            ? "finder-container"
            : segments[1] === "layout"
              ? "editor-container"
              : ""
        }`}
        tabIndex={-1}
      >
        {admin && (
          <nav className="admin-nav" aria-label="관리자 메뉴">
            <Link
              to="/admin/places"
              aria-current={
                segments[1] === "places" || segments[1] === "setup"
                  ? "page"
                  : undefined
              }
            >
              공간 관리
            </Link>
            <Link
              to="/admin/devices"
              aria-current={segments[1] === "devices" ? "page" : undefined}
            >
              장치 관리
            </Link>
            {auth.session && (
              <button
                onClick={async () => {
                  try {
                    await auth.logout()
                    setLogoutError("")
                  } catch {
                    setLogoutError(
                      "로그아웃에 실패했습니다. 다시 시도해 주세요.",
                    )
                  }
                }}
              >
                로그아웃
              </button>
            )}
          </nav>
        )}
        {logoutError && (
          <p role="alert" className="notice">
            {logoutError}
          </p>
        )}
        {route === "/admin/login" ? (
          <Login />
        ) : admin ? (
          <AdminGate>
            {segments[1] === "layout" && segments[2] ? (
              <LayoutEditor key={segments[2]} placeId={segments[2]} />
            ) : segments[1] === "setup" && segments[2] ? (
              <PlaceSetup key={segments[2]} placeId={segments[2]} />
            ) : segments[1] === "devices" ? (
              <DevicesAdmin />
            ) : (
              <PlacesAdmin />
            )}
          </AdminGate>
        ) : finder ? (
          <PlaceFinder
            placeId={segments[0] === "places" ? segments[1] : undefined}
            favoritesOnly={favorite}
            footer={footer}
          />
        ) : (
          <section className="login-panel">
            <h1>페이지를 찾을 수 없습니다</h1>
            <Link to="/">공간 목록으로 돌아가기</Link>
          </section>
        )}
        {!finder && footer}
      </main>
      <dialog
        ref={help}
        className="help-dialog"
        aria-labelledby="help-title"
        onClick={(e) => {
          if (e.target === e.currentTarget) help.current?.close()
        }}
      >
        <div className="dialog-heading flex items-center justify-between">
          <h2 id="help-title">빈자리 이용 안내</h2>
          <button
            className="icon-button"
            aria-label="안내 닫기"
            onClick={() => help.current?.close()}
          >
            <Icon name="close" />
          </button>
        </div>
        <dl className="help-states">
          {(["available", "occupied", "unknown"] as const).map((status) => (
            <div key={status}>
              <dt>
                <Swatch status={status} />
                {STATUS_LABEL[status]}
              </dt>
            </div>
          ))}
        </dl>
        <button
          className="primary-button"
          onClick={() => help.current?.close()}
        >
          닫기
        </button>
      </dialog>
    </div>
  )
}
