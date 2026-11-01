// Run against isolated browser profiles and the explicitly enabled dev simulator.
// CDP_MODULE points to taste-skill/scripts/lib/cdp.mjs (no package installs needed).
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
const { Browser, sleep } = await import(process.env.CDP_MODULE)
const { probe, app: appProbe, layout: layoutProbe } = await import(new URL('probe.mjs', process.env.CDP_MODULE).href)
const { judge, judgeApp, judgeLayout, APP_SKIP } = await import(new URL('rules.mjs', process.env.CDP_MODULE).href)
const browser = await Browser.launch()
const page = await browser.newPage({ width: 1440, height: 1000 })
// Hash routing does not fire Page.loadEventFired. Avoid a 25s navigation wait.
const originalGoto = page.goto.bind(page)
page.goto = url => originalGoto(url, { timeoutMs: 3000, settleMs: 300 })
const result = [],
  screenshots = []
const visualFindings = []
const dir = "../.taste-skill/integration-qa"
mkdirSync(dir, { recursive: true })
const passed = (name) => {
  result.push(name)
  console.log("PASS " + name)
}
async function content(selector, p = page) {
  return p.eval((s) => document.querySelector(s)?.textContent.trim(), selector)
}
async function waitFor(selector, p = page) {
  for (let i = 0; i < 60; i++) {
    if (await p.eval((s) => !!document.querySelector(s), selector)) return
    await sleep(100)
  }
  throw new Error("Missing: " + selector + "\n" + (await content("body", p)))
}
async function click(selector, p = page) {
  await waitFor(selector, p)
  const point = await p.eval((s) => {
    const e = document.querySelector(s)
    e.scrollIntoView({ block: "center", behavior: "instant" })
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  await p.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  })
  await p.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  })
  await sleep(140)
}
async function button(text, p = page) {
  const selector = await p.eval((t) => {
    const elements = [...document.querySelectorAll("button")].filter(
      (e) => e.textContent.trim() === t && e.getClientRects().length,
    )
    if (!elements.length) throw Error("Button not found: " + t)
    const e = elements[0]
    e.dataset.testTarget = "active"
    return '[data-test-target="active"]'
  }, text)
  await click(selector, p)
  await p.eval(() =>
    document
      .querySelectorAll("[data-test-target]")
      .forEach((e) => e.removeAttribute("data-test-target")),
  )
}
async function fill(selector, value, p = page) {
  await waitFor(selector, p)
  await p.eval(
    ({ selector, value }) => {
      const e = [...document.querySelectorAll(selector)].find(
        (e) =>
          e instanceof HTMLInputElement ||
          e instanceof HTMLTextAreaElement ||
          e instanceof HTMLSelectElement,
      )
      if (!e) throw Error("Missing field: " + selector)
      e.focus()
      const proto =
        e instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : e instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, "value").set.call(e, value)
      e.dispatchEvent(new Event("input", { bubbles: true }))
      e.dispatchEvent(new Event("change", { bubbles: true }))
    },
    { selector, value: String(value) },
  )
  await sleep(80)
}
async function property(name, value) {
  await fill(`[data-property="${name}"]`, value)
  await page.eval(
    (n) => document.querySelector(`[data-property="${n}"]`).blur(),
    name,
  )
  await sleep(100)
}
async function canvasClick(x, y) {
  const r = await page.eval(() => {
    const e = document.querySelector(".editable-canvas")
    e.scrollIntoView({ block: "center", behavior: "instant" })
    const r = e.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const point = { x: r.x + r.width * x, y: r.y + r.height * y }
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  })
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    clickCount: 1,
  })
  await sleep(120)
}
async function drag(selector, dx, dy) {
  const point = await page.eval((s) => {
    const e = document.querySelector(s)
    e.scrollIntoView({ block: "center", behavior: "instant" })
    const r = e.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    clickCount: 1,
  })
  for (let i = 1; i <= 5; i++)
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x + (dx * i) / 5,
      y: point.y + (dy * i) / 5,
      button: "left",
      buttons: 1,
    })
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x + dx,
    y: point.y + dy,
    button: "left",
    clickCount: 1,
  })
  await sleep(180)
}
async function login(p = page) {
  await fill("[name=username]", "admin", p)
  await fill("[name=password]", "dev-only", p)
  await button("로그인", p)
}
async function screenshot(name, p = page) {
  const path = `${dir}/${name}.jpg`
  await p.screenshot({ path, fullPage: true })
  screenshots.push(path)
}
async function measure(name, width) {
  await page.setViewport({ width, height: 900 }); await sleep(180)
  await page.eval(() => { document.querySelectorAll('details[open]').forEach(e => { e.open = false }); document.activeElement?.blur(); window.scrollTo(0, 0) })
  const metrics = await page.eval(probe), app = await page.eval(appProbe), layout = await page.eval(layoutProbe)
  const findings = [...judge(metrics, { width }), ...judgeLayout(layout, { width })].filter(f => !APP_SKIP.has(f.id) && f.id !== 'no-title' && f.id !== 'small-title')
  findings.push(...judgeApp(app, metrics, { width }))
  visualFindings.push({ name, width, findings, overflow: metrics.page.horizontalOverflow })
  assert.equal(metrics.page.horizontalOverflow, 0, `${name} page overflow at ${width}`)
  await screenshot(`${name}-${width}`)
}

try {
  await page.goto("http://127.0.0.1:4173")
  assert.equal(
    await page.eval(() => document.querySelectorAll(".room-item").length),
    0,
  )
  assert.match(await content("body"), /연결을 준비/)
  assert.equal(
    await page.eval(() => !!document.querySelector(".dev-panel")),
    false,
  )
  passed(
    "Production: no fictional places, no simulator, explicit integration-pending state",
  )
  await screenshot("production-user")
  await page.goto("http://127.0.0.1:8443/#/admin/places")
  await waitFor("[name=username]")
  await fill("[name=username]", "admin")
  await fill("[name=password]", "wrong")
  await button("로그인")
  assert.match(await content("[role=alert]"), /올바르지/)
  await login()
  await waitFor(".admin-panel")
  assert.match(await content("body"), /등록된 공간이 없습니다/)
  passed("Admin route guard, login failure, login success and empty place list")
  await button("공간 만들기")
  await fill("[name=name]", "프론트 검증실")
  await fill("[name=slug]", "frontend-qa")
  await fill("[name=description]", "개발 환경의 편집 기능 검증")
  await button("만들고 배치하기")
  await waitFor(".editable-canvas")
  const editorUrl = await page.eval(() => location.href),
    placeId = editorUrl.split("/").at(-1)
  await button("+ 좌석 추가")
  await canvasClick(0.2, 0.2)
  await property("number", "10")
  await property("width", "60")
  await button("+ 테이블 추가")
  await canvasClick(0.4, 0.4)
  await button("+ 좌석 추가")
  await canvasClick(0.65, 0.25)
  assert.equal(
    await page.eval(() => document.querySelectorAll(".editor-seat").length),
    2,
  )
  await property("number", "10")
  assert.match(await content("#property-errors"), /중복/)
  await property("number", "11")
  await fill(
    ".properties select",
    await page.eval(
      () =>
        document.querySelector(".properties select option:nth-child(2)").value,
    ),
  )
  const before = await page.eval(() =>
    Number(document.querySelector("[data-property=x]").value),
  )
  await drag(".selected-element", -70, 40)
  const moved = await page.eval(() =>
    Number(document.querySelector("[data-property=x]").value),
  )
  assert.notEqual(moved, before)
  await button("실행 취소")
  assert.equal(
    await page.eval(() =>
      Number(document.querySelector("[data-property=x]").value),
    ),
    before,
  )
  await button("다시 실행")
  assert.equal(
    await page.eval(() =>
      Number(document.querySelector("[data-property=x]").value),
    ),
    moved,
  )
  await drag(".resize-handle", 20, 15)
  assert.ok(
    (await page.eval(() =>
      Number(document.querySelector("[data-property=width]").value),
    )) > 44,
  )
  await drag(".rotate-handle", 40, 25)
  assert.ok(
    (await page.eval(() =>
      Number(document.querySelector("[data-property=rotation]").value),
    )) > 0,
  )
  passed(
    "Add, unique number validation, table linking, drag, single-step undo/redo, resize and rotate",
  )
  await button("배치 저장")
  assert.match(await content(".editor-heading p"), /저장됨/)
  const savedCount = await page.eval(
    () => document.querySelectorAll(".editor-element").length,
  )
  await page.goto(editorUrl)
  await waitFor(".editable-canvas")
  assert.equal(
    await page.eval(() => document.querySelectorAll(".editor-element").length),
    savedCount,
  )
  passed("Layout persists across page reload in the development store")
  await button("+ 좌석 추가")
  await canvasClick(0.15, 0.6)
  await click(".dev-panel summary")
  await button("다음 저장 실패")
  await button("배치 저장")
  assert.match(await content(".error-notice"), /실패/)
  assert.equal(
    await page.eval(() => document.querySelectorAll(".editor-seat").length),
    3,
  )
  await button("배치 저장")
  assert.match(await content(".editor-heading p"), /저장됨/)
  passed("Failed save retains draft; retry saves successfully")
  // A second authenticated tab writes the same place, using the development service.
  const other = await browser.newPage({ width: 1440, height: 900 })
  const otherGoto = other.goto.bind(other)
  other.goto = url => otherGoto(url, { timeoutMs: 3000, settleMs: 300 })
  await other.goto(editorUrl)
  await login(other)
  await waitFor(".editable-canvas", other)
  await button("+ 좌석 추가")
  await canvasClick(0.75, 0.7)
  await other.eval(async (id) => {
    const { devService } = await import("/src/dev/service.ts")
    const layout = await devService.getLayout(id)
    layout.tables[0].x += 10
    await devService.saveLayout(layout)
  }, placeId)
  await sleep(250)
  await button("배치 저장")
  assert.match(await content(".conflict-notice"), /다른 창/)
  assert.match(await content(".error-notice"), /먼저 저장/)
  passed(
    "Concurrent-tab revision conflict never silently overwrites the saved layout",
  )
  // Keep this conflicting draft, expire auth, and verify draft recovery.
  await button("인증 만료")
  await waitFor("[name=username]")
  await login()
  await waitFor(".editable-canvas")
  assert.equal(
    await page.eval(() => document.querySelectorAll(".editor-seat").length),
    4,
  )
  assert.match(await content("body"), /초안을 복원/)
  passed(
    "Expired admin session blocks editor; signing back in restores the unsaved draft",
  )
  await screenshot("editor-desktop")
  // The cancelled native confirm above correctly keeps this unsaved screen.
  // Finish the conflict UI flow with an explicit affirmative user confirmation.
  await button("최신 배치 확인")
  await page.eval(() => {
    window.confirm = () => true
  })
  await button("최신 배치로 다시 시작")
  assert.match(await content(".editor-heading p"), /저장됨/)
  await page.goto("http://127.0.0.1:8443/#/admin/devices")
  await waitFor(".admin-panel")
  await button("장치 등록")
  await fill("[name=name]", "OpenMV 검증 장치")
  await fill("[name=identifier]", "openmv-qa")
  await waitFor(".assignment-grid input")
  await button("선택 가능한 좌석 전체")
  await button("등록하고 토큰 발급")
  await waitFor(".token-value")
  const token = await page.eval(
    () => document.querySelector(".token-value").value,
  )
  assert.ok(token.startsWith("dev_"))
  await button("보관했어요")
  assert.equal(
    await page.eval(() => document.body.textContent.includes("dev_" + "")),
    false,
  )
  await screenshot("devices-desktop")
  passed(
    "Device registration, seat assignment, one-time token disclosure and persisted settings",
  )
  await page.goto(`http://127.0.0.1:8443/#/places/${placeId}`)
  await waitFor(".spatial-seat")
  await page.eval(
    async ({ token }) => {
      const { devControls } = await import("/src/dev/service.ts")
      await devControls.ingest("openmv-qa", token, [
        { number: 10, status: "available" },
        { number: 11, status: "occupied" },
      ])
    },
    { token },
  )
  await sleep(250)
  assert.equal(await content(".available-stat b"), "1")
  assert.equal(
    await page.eval(() => document.querySelectorAll(".seat-available").length),
    1,
  )
  await other.goto(`http://127.0.0.1:8443/#/places/${placeId}`)
  await waitFor(".spatial-seat", other)
  assert.equal(await content(".available-stat b", other), "1")
  await page.eval(async () => {
    const { devControls } = await import("/src/dev/service.ts")
    devControls.disconnect(true)
  })
  await sleep(100)
  assert.equal(await content(".available-stat b"), "0")
  assert.match(await content(".freshness-note"), /연결 중단/)
  await page.eval(async () => {
    const { devControls } = await import("/src/dev/service.ts")
    devControls.disconnect(false)
  })
  await sleep(100)
  assert.equal(await content(".available-stat b"), "1")
  passed(
    "Simulated authenticated device updates, two viewers, disconnect masking and snapshot resynchronization",
  )
  await click(".favorite-button")
  await click(".view-switch button:last-child")
  assert.equal(
    await page.eval(
      () => document.querySelectorAll(".number-view .seat-button").length,
    ),
    3,
  )
  await click(".available-filter input")
  assert.equal(
    await page.eval(
      () => document.querySelectorAll(".number-view .seat-button").length,
    ),
    1,
  )
  await click(".view-switch button:first-child")
  await screenshot("user-desktop")
  for (const width of [768, 390, 320]) {
    await page.setViewport({ width, height: 900 })
    await sleep(180)
    assert.ok(
      await page.eval(() => document.documentElement.scrollWidth <= innerWidth),
      `No overflow at ${width}`,
    )
    await screenshot(`user-${width}`)
  }
  passed(
    "Favorites, accessible numbered seats, availability filtering and responsive user layouts",
  )
  await page.setViewport({ width: 1440, height: 1000 })
  await page.eval(async () => {
    const { devControls } = await import("/src/dev/service.ts")
    await devControls.resetReadings()
  })
  await sleep(100)
  assert.equal(await content(".available-stat b"), "0")
  assert.equal(
    await page.eval(() => document.querySelectorAll(".seat-unknown").length),
    3,
  )
  passed(
    "Resetting transient development readings preserves layout and returns every seat to unknown",
  )
  await page.goto(editorUrl)
  await waitFor('.editable-canvas')
  await click('.editor-table')
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 })
  assert.equal(await page.eval(() => document.querySelectorAll('.editor-table').length), 0)
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 })
  await sleep(100)
  assert.equal(await page.eval(() => document.querySelectorAll('.editor-table').length), 1)
  await click('.editor-seat')
  await fill('[data-property=width]', '70')
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 })
  await sleep(250)
  assert.match(await content('.editor-heading p'), /저장됨/)
  await page.goto(editorUrl)
  await waitFor('.editable-canvas')
  await click('.editor-seat')
  assert.equal(await page.eval(() => document.querySelector('[data-property=width]').value), '70')
  await button('미리보기'); assert.ok(await page.eval(() => !!document.querySelector('.editor-preview')))
  await button('편집으로 돌아가기')
  passed('Delete and Ctrl+Z shortcuts, Ctrl+S commits an active property field, read-only preview')
  await page.goto('http://127.0.0.1:8443/#/admin/devices'); await waitFor('.admin-panel')
  await button('장치 등록'); await fill('dialog [name=name]', '추가 검증 장치'); await fill('dialog [name=identifier]', 'other-qa')
  assert.equal(await page.eval(() => [...document.querySelectorAll('.assignment-grid input')].every(input => input.disabled)), true)
  await button('취소')
  await button('토큰 재발급'); await button('재발급'); await waitFor('.token-value')
  const newToken = await page.eval(() => document.querySelector('.token-value').value)
  assert.notEqual(newToken, token); await button('보관했어요')
  const oldTokenDenied = await page.eval(async token => { const { devControls } = await import('/src/dev/service.ts'); try { await devControls.ingest('openmv-qa', token, [{ number: 10, status: 'available' }]); return false } catch { return true } }, token)
  assert.equal(oldTokenDenied, true)
  await button('장치 설정'); await click('dialog [name=enabled]'); await button('설정 저장')
  assert.match(await content('.data-table'), /비활성화됨/)
  const disabledDenied = await page.eval(async token => { const { devControls } = await import('/src/dev/service.ts'); try { await devControls.ingest('openmv-qa', token, [{ number: 10, status: 'available' }]); return false } catch { return true } }, newToken)
  assert.equal(disabledDenied, true)
  await button('장치 설정'); await click('dialog [name=enabled]'); await button('설정 저장')
  await page.eval(async token => { const { devControls } = await import('/src/dev/service.ts'); await devControls.ingest('openmv-qa', token, [{ number: 10, status: 'available' }]) }, newToken)
  passed('Duplicate seat assignment is disabled; token rotation revokes old token; disabled device cannot send readings')
  await page.goto('http://127.0.0.1:8443/#/admin/places'); await waitFor('.places-table')
  await button('설정'); await fill('dialog [name=canvasWidth]', '100'); await button('변경사항 저장')
  assert.match(await content('dialog [role=alert]'), /캔버스/)
  await fill('dialog [name=canvasWidth]', '1000'); await fill('dialog [name=name]', '이름을 수정한 검증실'); await fill('dialog [name=slug]', 'renamed-qa'); await button('변경사항 저장')
  assert.match(await content('.places-table'), /이름을 수정한/)
  await screenshot('places-desktop')
  for (const width of [768, 390]) { await page.setViewport({ width, height: 900 }); await sleep(100); assert.ok(await page.eval(() => document.documentElement.scrollWidth <= innerWidth)); await screenshot(`places-${width}`) }
  await page.setViewport({ width: 1440, height: 900 })
  await button('삭제'); assert.match(await content('dialog'), /장치 설정도 함께 삭제/); await button('공간 삭제')
  assert.match(await content('.admin-panel'), /등록된 공간이 없습니다/)
  await page.goto(`http://127.0.0.1:8443/#/places/${placeId}`); await waitFor('.data-state')
  assert.match(await content('.data-state'), /삭제된 공간/)
  await page.goto('http://127.0.0.1:8443/#/admin/places'); await button('로그아웃'); await waitFor('[name=username]')
  passed('Canvas shrink validation, place rename/slug edit, deletion impact confirmation, missing place state and logout')
  // Dense design fixtures are created explicitly for visual QA only.
  await login(); await waitFor('.admin-panel')
  const visualPlace = await page.eval(async () => {
    const { devControls, devService } = await import('/src/dev/service.ts')
    const place = await devControls.seed(), layout = await devService.getLayout(place.id)
    const { token } = await devService.createDevice({ name: 'OpenMV 개발 카메라', identifier: 'visual-qa', placeId: place.id, enabled: true, seatIds: layout.seats.map(s => s.id) })
    await devControls.ingest('visual-qa', token, layout.seats.map(s => ({ number: s.number, status: s.number % 7 === 0 ? 'unknown' : s.number % 3 === 0 ? 'available' : 'occupied' })))
    return place.id
  })
  await page.goto(`http://127.0.0.1:8443/#/places/${visualPlace}`); await waitFor('.spatial-seat')
  for (const width of [1440, 768, 390]) await measure('final-user', width)
  await page.goto(`http://127.0.0.1:8443/#/admin/layout/${visualPlace}`); await waitFor('.editable-canvas')
  await page.setViewport({ width: 1440, height: 900 }); await click('.editor-seat')
  for (const width of [1440, 768, 390]) await measure('final-editor', width)
  await page.goto('http://127.0.0.1:8443/#/admin/devices'); await waitFor('.data-table')
  for (const width of [1440, 768, 390]) await measure('final-devices', width)
  await page.goto('http://127.0.0.1:4173/#/admin/login'); await waitFor('.login-panel')
  for (const width of [1440, 768, 390]) await measure('final-login-production', width)
  passed('Actual browser visual QA at 1440, 768 and 390 for user, editor, devices and production login')
  assert.deepEqual(page.consoleErrors, [])
  assert.deepEqual(other.consoleErrors, [])
  passed("No browser runtime exceptions")
} catch (error) {
  await screenshot("failure")
  console.error(error)
  process.exitCode = 1
} finally {
  writeFileSync(
    `${dir}/results.json`,
    JSON.stringify(
      { results: result, screenshots, visualFindings, browserErrors: page.consoleErrors },
      null,
      2,
    ),
  )
  await browser.close()
}
