# Comsigi 보안 점검 보고서

점검일: 2026년 11월 2일. 기준 커밋: `8ddb810`.

애플리케이션 코드, 배포 설정, 의존성 잠금 파일, Git 이력을 점검한 결과 보안 취약점과 조건부 위험 9개 항목을 확인했다. 우선 조치 대상은 비인증 요청의 자원 소비 제한과 오래된 pnpm 잠금 파일이다. 이 보고서는 발견 당시 상태를 기록하며, 아래 수정안은 아직 적용하지 않았다.

## 범위와 판단 기준

- FastAPI 인증·권한·입력 검증·상태 처리·WebSocket과 React의 인증·출력 경로를 점검했다.
- 임시 SQLite DB와 로컬 서버, 더미 자격증명을 사용했다. 운영 서버에 공격 요청을 보내거나 실제 메모리 고갈을 유발하지 않았다.
- 운영 프록시의 본문 제한·TLS·IP 전달 정책, 방화벽, 실물 장치 펌웨어는 검증 범위 밖이다. 외부 방어 설정에 따라 실제 노출 정도가 달라진다.
- 심각도는 프로젝트 맥락의 우선순위 평가다. 의존성 권고의 버전 매칭은 실제 악용 성공과 구분한다. 모든 취약점이 발견되었다는 보장은 아니다.

## 발견 사항 요약

| 번호 | 심각도 | 문제 | 확인 수준 |
| --- | --- | --- | --- |
| 1 | 높음 | 인증 전 무제한 HTTP 본문 수신·파싱 | 2 MiB 초과 본문으로 재현 |
| 2 | 높음 | 로그인 해시 검증 동시 실행 제한 부재 | 대체 검증 함수로 10건 동시 진입 확인 |
| 3 | 중간 | 단일 클라이언트의 전체 WebSocket 한도 독점 | 축소된 연결 상한으로 재현 |
| 4 | 중간 | 없는 공간 조회도 전체 상태 계산 수행 | 404 요청의 전역 계산 횟수 확인 |
| 5 | 중간 | 시뮬레이터 리다이렉트 시 장치 키 전달 | 다른 Origin으로 더미 키 전달 재현 |
| 6 | 중간 | 관리자 화면 클릭재킹 방어 부재 | HTML 응답 헤더 확인, UI 공격 미재현 |
| 7 | 중간 | 공유 IP의 로그인 차단 전파 | 정상 관리자 로그인 429 재현 |
| 8 | 낮음 | 비ASCII 장치 세션 ID의 미처리 예외 | TypeError 재현 |
| 9 | 높음 포함 | pnpm 잠금 파일의 취약한 Vite 버전 | 공개 권고 7건 매칭, 조건별 적용성 검토 |

## 상세 결과

### 1 인증 전에 HTTP 본문을 제한 없이 파싱

근거: [app/main.py](../app/main.py)의 `prevent_stale_caches`, [app/api/auth.py](../app/api/auth.py)의 `login`, [app/cli.py](../app/cli.py)의 서버 설정.

FastAPI가 본문 전체를 읽고 JSON을 파싱한 뒤 인증 의존성이나 로그인 제한을 평가한다. 애플리케이션에 본문 크기 제한이 없고, CLI의 `ws_max_size`는 WebSocket 전용이다. 스키마의 문자열·배열 길이 제한도 JSON 파싱 이전 비용을 제한하지 못한다.

인증 없는 관리자 요청과 이미 로그인 제한에 걸린 요청에 2 MiB 이상의 공백을 붙인 유효 JSON을 전달했다. 두 경우 모두 전체 본문 파싱 후 각각 401과 429를 반환했다. 대형 요청 반복으로 메모리·CPU를 소비할 수 있다. README는 프록시 본문 제한을 권고하지만 실제 운영 설정은 확인하지 않았다.

**수정:** ASGI 수신 단계에서 누적 바이트 제한을 적용하고 초과 시 413으로 종료한다. `Content-Length`만 검사하지 말고 청크 전송도 제한한다. 본문 수신 시간과 동시 요청 수도 제한한다.

### 2 로그인 해시 검증의 동시 실행 제한 부재

근거: [app/api/auth.py](../app/api/auth.py)의 `run_in_threadpool`, [app/security.py](../app/security.py)의 `check_login_limit`.

IP당 60초에 10회라는 횟수 제한은 동시 실행을 제한하지 않는다. 존재하지 않는 계정도 Argon2 검증을 수행한다. 한 IP의 요청 10개가 동시에 검증 함수에 진입했다.

현재 Argon2 설정은 `m=65536,t=3,p=4`로 검증당 메모리 약 64 MiB를 사용한다. 10개가 겹치면 해시 작업에만 약 640 MiB가 필요할 수 있어 저메모리 서버가 특히 취약하다. 이는 설정으로부터 계산한 추정치이며, 재현에서는 실제 메모리 부하를 피하기 위해 검증 함수를 대체했다.

**수정:** 해시 검증 전 전역 동시 실행 제한과 대기열 상한을 적용한다. IP·계정별 요청 제한도 함께 유지한다.

### 3 WebSocket 연결 한도의 독점

근거: [app/realtime.py](../app/realtime.py)의 `subscribe`, [app/api/router.py](../app/api/router.py)의 `websocket_endpoint`, [app/config.py](../app/config.py)의 `max_ws_connections`.

전체 연결 상한은 기본 1,000개지만 IP별 상한이 없다. Origin 없는 비브라우저 연결도 허용한다. 한 클라이언트가 연결을 유지하며 전체 한도를 채우면 다른 공간의 정상 사용자도 연결할 수 없다. 상한을 3개로 낮춘 테스트에서 첫 공간의 연결 3개가 두 번째 공간의 연결을 차단했다.

**수정:** IP별 동시 연결 수와 신규 연결 속도, 공간별 할당량을 제한한다. Origin 검사는 비브라우저 클라이언트에 대한 접근 통제가 아니다.

### 4 없는 공간 조회에 의한 전체 상태 계산

근거: [app/api/router.py](../app/api/router.py)의 `state`·`snapshot`·`legacy_seats`, [app/realtime.py](../app/realtime.py)의 `expire`.

공간 존재 여부 확인 전에 `expire()`를 실행한다. 이 함수는 모든 공간의 상태를 전역 잠금 안에서 계산한다. 존재하지 않는 공간의 상태 조회 5번으로 모든 공간의 상태 계산이 각각 5번 발생했다.

공간·좌석·관측 데이터가 많을수록 작은 비인증 요청의 비용이 커진다. 같은 잠금을 사용하는 장치 보고와 관리 작업도 지연될 수 있다. 실제 장애를 일으키는 데이터량·요청률은 측정하지 않았다.

**수정:** 대상 공간을 먼저 검증한다. 만료 처리는 주기 작업이나 해당 공간 범위로 제한하고, 조회 결과 캐시와 요청 속도 제한을 검토한다.

### 5 시뮬레이터 리다이렉트의 장치 키 유출

근거: [scripts/simulate_device.py](../scripts/simulate_device.py)의 `post`.

`urlopen()`이 302 응답을 따라가며 `Authorization: Bearer …`를 다른 Origin에도 전달한다. 로컬 서버 두 개를 사용해 다른 포트의 목적지에 더미 장치 키가 도착하는 것을 재현했다.

악용에는 초기 서버·프록시의 리다이렉트 제어 또는 HTTP 통신 변조 등의 조건이 필요하다. 유출된 키는 장치를 비활성화하거나 키를 교체하기 전까지 해당 장치 권한으로 사용할 수 있다.

**수정:** 인증 요청의 자동 리다이렉트를 거부하거나 동일 Origin·HTTPS로 제한한다. 실제 네트워크에서 사용하는 장치 URL은 HTTPS를 요구한다.

### 6 관리자 화면 클릭재킹 방어 부재

근거: [app/main.py](../app/main.py)의 HTTP 미들웨어·정적 파일 제공, [frontend/index.html](../frontend/index.html).

HTML 응답에 `X-Frame-Options`와 CSP `frame-ancestors`가 모두 없다. 외부 페이지가 화면을 프레임에 삽입하고 클릭을 유도할 수 있다. CORS는 프레임 삽입을 막지 않는다.

관리자 토큰은 메모리에만 있으므로 기존 탭의 로그인이 새 프레임에 자동 승계되지는 않는다. 프레임 안에서 로그인하도록 유도하는 등의 사용자 상호작용이 필요하다. 헤더 부재를 확인했으며 실제 브라우저 공격 흐름은 재현하지 않았다. 운영 프록시가 해당 헤더를 추가하는지도 확인해야 한다.

**수정:** HTTP 응답에 CSP `frame-ancestors 'none'` 또는 허용된 Origin 정책을 적용한다. 필요하면 `X-Frame-Options: DENY`도 함께 제공한다. [OWASP 클릭재킹 방어 지침](https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html)

### 7 공유 IP의 로그인 차단 전파

근거: [app/security.py](../app/security.py)의 `check_login_limit`, [app/api/auth.py](../app/api/auth.py)의 클라이언트 IP 사용.

로그인 제한 키가 IP뿐이다. 임의 계정 10개로 실패한 뒤 올바른 관리자 자격증명을 제출해도 429가 반환됐다. 같은 NAT를 사용하는 공격자나, 모든 사용자가 하나의 프록시 IP로 인식되는 배포 환경에서 정상 로그인을 반복적으로 차단할 수 있다.

이 위험은 문서에도 언급된 운영 조건부 약점이다. 반대로 계정별 제한이 없어 여러 IP의 동일 계정 공격을 계정 단위로 집계하지 못한다.

**수정:** 신뢰할 프록시와 전달 IP 처리 정책을 확인한다. IP·계정·전체 요청 제한을 조합하되 계정 영구 잠금으로 새 서비스 거부 경로를 만들지 않도록 설계한다.

### 8 비ASCII 장치 세션 ID의 미처리 예외

근거: [app/schemas.py](../app/schemas.py)의 `HardwareReport.session_id`, [app/realtime.py](../app/realtime.py)의 `ingest`.

세션 ID는 길이만 검사한다. 유효한 장치 키와 `é` 같은 비ASCII 문자가 포함된 세션 ID를 제출하면 문자열 `compare_digest()`에서 `TypeError`가 발생해 500으로 이어진다. 장치 인증이 선행되므로 비인증 공격이나 인증 우회로 분류하지 않는다. 프로세스 종료도 확인되지 않았다.

**수정:** 발급 형식에 맞는 ASCII URL-safe 문자와 길이를 검증해 422로 거절한다.

### 9 pnpm 잠금 파일의 취약한 Vite 버전

근거: [frontend/pnpm-lock.yaml](../frontend/pnpm-lock.yaml)은 Vite **8.0.5**, [frontend/package-lock.json](../frontend/package-lock.json)은 **8.3.5**를 고정한다. [railway.toml](../railway.toml)은 npm을 사용한다. [frontend/vite.config.ts](../frontend/vite.config.ts)의 개발·프리뷰 서버는 `0.0.0.0`에 바인딩한다.

pnpm 잠금 파일의 패키지 92개를 OSV에 조회했으며 Vite에 아래 7개 권고가 매칭됐다. 아래는 버전과 공개 권고의 대조 결과이며, 취약한 버전을 설치하거나 명령 실행·인증 정보 탈취를 재현하지 않았다. 현재 npm 설치와 Railway의 정적 빌드를 이 취약한 개발 서버 구성으로 간주해서는 안 된다.

| 공개 권고 | 영향과 조건 |
| --- | --- |
| [CVE-2026-112942](https://github.com/vitejs/launch-editor/security/advisories/GHSA-587h-7wmj-h5pm) | Windows 경로 존재 검사 우회. 아래 명령 인젝션과 결합 가능. 공개 심각도 높음 |
| [CVE-2026-112943](https://github.com/vitejs/launch-editor/security/advisories/GHSA-698v-4r3x-3vcv) | Windows의 명령 인자 이스케이프 누락. 환경변수·파일 등의 추가 조건 존재 |
| [CVE-2026-53571](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff) | Windows 특수 경로로 파일 접근 차단 우회. 네트워크에 노출된 개발 서버와 허용 디렉터리의 민감 파일 필요 |
| [CVE-2026-53632](https://github.com/vitejs/launch-editor/security/advisories/GHSA-v6wh-96g9-6wx3) | Windows UNC 접근을 통한 NTLMv2 인증 정보 유출. NTLM 활성화 등 조건 필요 |
| [CVE-2026-112944](https://github.com/vitejs/launch-editor/security/advisories/GHSA-r825-w8mm-5pxw) | Vite에서는 WSL·특정 편집기·공격자 파일 생성 조건의 명령 실행. 현재 Windows 네이티브 환경의 악용 미확인 |
| [CVE-2026-112945](https://github.com/vitejs/vite/security/advisories/GHSA-9jrq-w75r-8gcw) | 사용자 정의 미들웨어의 스크립트 실행 문제. 현재 프로젝트에서 해당 미들웨어·인라인 모듈 구성 미발견 |
| [CVE-2026-112946](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22) | 비Windows에서 특정 import 경로가 시스템 경로와 일치하면 파일 노출. 현재 환경에서는 조건 미충족 |

**수정:** npm·pnpm 중 하나로 통일하거나 두 잠금 파일을 수정된 버전으로 동기화한다. 점검 시 npm의 Vite 8.3.5에서는 위 권고가 매칭되지 않았다. 개발 서버는 외부 접근이 필요하지 않으면 loopback에 바인딩한다.

## 추가 설계 및 운영 보강

- **장치별 좌석 권한:** 현재 장치 하나가 소속 공간 전체 좌석을 보고할 수 있다. 문서에 명시된 설계이므로 인증 우회는 아니지만, 키 하나의 유출이 공간 전체 상태 오염으로 이어질 수 있다. 장치를 개별 신뢰 경계로 취급한다면 서버 측 좌석 ACL이 필요하다.
- **보안 감사로그:** 관리자 변경·키 교체에 행위자와 대상·결과를 기록하는 감사로그가 없다. 일반 접근 로그만으로는 행위자 추적이 충분하지 않다. 토큰·비밀번호 원문은 기록하지 않아야 한다.
- **배포 설정:** HTTPS/WSS, 요청 본문·수신 시간 제한, 신뢰 프록시 IP 처리를 실제 배포에서 검증해야 한다. 저장소의 문서상 권고가 운영 적용을 보증하지 않는다.

## 검증 기록

| 항목 | 결과 |
| --- | --- |
| 기존 백엔드 테스트 | 66개 통과 |
| 기존 프런트엔드 테스트 | 17개 통과 |
| 프런트엔드 타입 검사·운영 빌드 | 통과, 개발 데이터·개발 자격증명 제거 검사 통과 |
| 보안 확인용 로컬 테스트 | 8개 통과. 안전성을 증명하는 회귀 테스트가 아니라 위 문제 동작·조건을 확인하는 테스트 |
| npm audit | 알려진 취약점 0건 |
| Python uv.lock OSV 조회 | 패키지 42개, 매칭 0건 |
| pnpm-lock.yaml OSV 조회 | 패키지 92개, Vite 권고 7건 매칭 |
| Git 이력 비밀키 패턴 검색 | 11개 커밋·199개 고유 blob, 대표 개인키·AWS·GitHub·OpenAI 키 패턴 일치 없음 |

관리자 인증 우회, SQL 인젝션, 직접적인 XSS 경로는 이번 점검에서 발견하지 못했다. 패턴 검색과 공개 취약점 DB의 미탐지는 안전성 보증이 아니다.

로컬 증거는 `.test-tmp/security-review/`에 보관되어 있다. `test_security_findings.py`와 OSV 요청·응답 JSON은 Git에서 무시되는 임시 산출물이므로 다른 체크아웃에는 포함되지 않는다. 재현 테스트는 저장소의 `tests/conftest.py`를 사용하며 임시 DB만 조작한다.

```powershell
# 저장소 루트에서 실행. 재실행 시 새 basetemp 경로를 사용한다.
.\.venv\Scripts\python.exe -m pytest -q -s .test-tmp/security-review/test_security_findings.py --basetemp=".test-tmp/security-recheck-$([guid]::NewGuid().ToString('N'))"
```

## 수정 우선순위

1. HTTP 본문·수신 시간 제한과 로그인 해시 검증 동시 실행 제한을 적용한다.
2. pnpm 잠금 파일을 정리하고 개발 서버 접근 범위를 제한한다.
3. 시뮬레이터의 인증 리다이렉트 정책을 수정한다.
4. WebSocket 할당량과 조회 시 전체 상태 계산을 개선한다.
5. 클릭재킹 방어·로그인 제한 정책·세션 ID 검증을 보완한다.
6. 배포 설정을 확인하고, 장치 권한 세분화와 보안 감사로그를 검토한다.

수정 후에는 각 재현 테스트를 정상 거절·자원 상한·권한 격리를 검증하는 회귀 테스트로 변경해야 한다.
