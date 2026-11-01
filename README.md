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

프런트엔드에는 사용자 좌석 조회, 관리자 공간·배치 편집 및 장치 관리 화면이 있습니다.
백엔드 코드는 수정하지 않았으며 실제 통합은 보류 상태입니다. 기본 실행과 운영 빌드는
가상의 장소를 표시하지 않고 연결 준비 상태를 안내합니다.

개발 서버에서 `VITE_ENABLE_DEV_DATA=true`를 명시한 경우에만 브라우저 저장소 기반
시뮬레이터를 사용할 수 있습니다. 기존 `VITE_SEATS_API_URL`은 새 화면의 연결 설정으로
사용하지 않습니다. 실행 방법은 [프런트엔드 안내](frontend/README.md), 변경 및 검증 결과는
[구현 보고서](frontend/IMPLEMENTATION.md)를 참고하세요.

현재 `/api/v1/seats`는 센서 및 DB 연동 전까지 빈 목록을 반환합니다. 장소·배치·인증·장치·
WebSocket 계약이 추가된 후 연결할 항목은 [통합 안내](frontend/INTEGRATION.md)에 정리했습니다.
