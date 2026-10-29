# Comsigi Backend

FastAPI 기반 백엔드입니다. Python 3.11 이상이 필요합니다.

## 설치

프로젝트 루트에서 실행합니다.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

macOS / Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e .
```

## 개발 서버 실행

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

macOS / Linux:

```bash
.venv/bin/python -m uvicorn app.main:app --reload
```

- Swagger UI: http://127.0.0.1:8000/docs
- ReDoc: http://127.0.0.1:8000/redoc
- 헬스체크: http://127.0.0.1:8000/api/v1/health → `{"status":"ok"}`
- 좌석 조회: http://127.0.0.1:8000/api/v1/seats → `{"seats":[]}` (데이터 연동 전)

`--reload`는 개발 환경에서만 사용합니다.

## 구조

```text
app/
  main.py         # FastAPI 앱 생성 및 라우터 등록
  api/
    router.py     # /api/v1 라우터
pyproject.toml    # 패키지 설정 및 의존성
```

로컬 환경 변수는 `.env`에 보관합니다. `.env`와 가상환경, 캐시,
빌드 산출물은 Git에서 제외됩니다. 환경 변수 자동 로딩은 별도로 설정해야 합니다.

## 프런트엔드 좌석 데이터

프런트엔드는 `GET /api/v1/seats`를 요청하고, 요청 완료 후 3초마다 갱신합니다.
Vite 개발 서버의 `/api` 요청은 `http://127.0.0.1:8000`으로 전달됩니다.
다른 API를 사용하려면 `frontend/.env.local`에 `VITE_SEATS_API_URL`을 설정하고
개발 서버를 재시작합니다. 별도 도메인의 API는 해당 서버에서 CORS를 허용해야 합니다.
배포 시에는 `/api`를 백엔드로 프록시하거나 빌드 시 API 주소를 설정해야 합니다.

예상 응답 형식 (아래 값은 형식 설명용입니다):

```json
{"seats":[{"id":1,"status":"available"},{"id":2,"status":"occupied"},{"id":3,"status":"unknown"}]}
```

좌석 ID는 중복 없는 양의 정수이며, 화면은 ID 순으로 정렬됩니다.
알 수 없는 상태는 `unknown`으로 처리합니다. 로딩 중이거나 요청 실패 시 수치는
`–`로 표시하며 자동 재시도합니다. 빈 배열은 등록된 좌석이 없는 상태입니다.

현재 좌석 API는 구현되어 있으며, 센서 및 DB 연동 전까지 빈 목록을 반환합니다.
백엔드 실행 시 화면에는 등록된 좌석이 없는 상태로 표시됩니다.
