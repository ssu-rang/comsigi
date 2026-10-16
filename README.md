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
