# 로그인 보안 검증 기록
기준: UI GuideBook 로그인 보안 체크리스트 · 2026-11-06 · 대상: note.leo0409.work
자동 검증은 `app/src/auth.test.js`, 운영 응답은 curl로 확인했어요. 실제 Google 계정 로그인은 사용자가 성공을 확인했어요.

## 미해결 (출시 전 판단 필요)
| 항목 ID | 상태 | 구현 위치 | 검증 방법·증거 | 잔여 위험·담당자·기한 |
|---|---|---|---|---|
| AUTH-1-07 | FAIL | Google 클라이언트 | 로컬과 운영이 같은 클라이언트 사용 | 운영용 분리 필요. 미정 |
| AUTH-1-08 | 미검증 | 없음 | CI와 의존성 검사 없음 | 저장소 구성 후 적용 |
| AUTH-1-09 | FAIL | worker.js | /api 응답에만 HSTS 적용, 정적 파일은 미적용 | Cloudflare 영역 설정 필요 |
| AUTH-3-13 | FAIL | 없음 | CSP 없음 (Should) | 출력 이스케이프로 방어 중 |
| AUTH-6-11 | 미검증 | auth.js | state 소비에 KV 사용, 원자적이지 않음 | Google 인증 코드가 일회용이라 2차 방어 |
| AUTH-8.1-01~04 | FAIL | auth.js | 콘솔 기록만 있고 보존·경보 없음 | 로그 보존 설정과 경보 필요 |
| AUTH-2-08 | 미검증 | Google 계정 | Google 계정의 2단계 인증 사용 여부에 의존 | 나희 계정에서 확인 필요 |

## 통과
| 항목 ID | 상태 | 구현 위치 | 검증 방법·증거 |
|---|---|---|---|
| AUTH-1-01 | PASS | Cloudflare Always Use HTTPS | http 요청 301로 https 전환 curl 확인 |
| AUTH-1-04 | PASS | store.js | 모든 D1 쿼리에 매개변수 바인딩 사용 |
| AUTH-1-03 | PASS | worker.js, store.js | 본문 4MB 제한, 입력 타입·길이 검사 테스트 |
| AUTH-1-02, 1-06, 1-10 | PASS | auth.js, worker.js | 세션은 쿠키만, 비밀값은 Worker secret, 응답 no-store 확인 |
| AUTH-2-01, 2-03 | PASS | worker.js | 세션 없음 401, 저장소 오류 시 502로 차단 |
| AUTH-2-04, 2-05 | PASS | AUTH_LIMIT | 인증 시작·콜백 IP당 분당 10회, 429 테스트 |
| AUTH-3-01, 3-02, 3-03 | PASS | auth.js | HttpOnly·Secure·SameSite=Lax, Origin 검사 403 확인 |
| AUTH-3-04, 3-05 | PASS | worker.js | 상태 변경은 POST만, CORS 미허용 |
| AUTH-3-06 | PASS | main.js | 출력에 esc 적용 (코드 확인) |
| AUTH-3-07 | PASS | main.js | 접속 코드 제거, 로그인 여부 표시만 저장 |
| AUTH-3-08~3-12 | PASS | auth.js | 난수 세션, 해시 저장, 30일 유휴·90일 절대 만료, 서버 폐기, 전체 로그아웃 테스트 |
| AUTH-6-01~6-10 | PASS | auth.js | PKCE S256, state·nonce, 브라우저 연결, 재사용 거부, 고정 Redirect URI, 서버 코드 교환 테스트 |
| AUTH-7-01, 7-02, 7-04, 7-06 | PASS | auth.js | ID 토큰 서명·iss·aud·exp·nonce 검증, iss+sub 고정, 이메일은 최초 1회만 사용 |
| AUTH-7-10~7-14 | PASS | auth.js | scope는 openid email, Google 토큰 미저장, email_verified 확인, 서비스 로그아웃만 수행 |

## 해당 없음
| 항목 ID | 이유 |
|---|---|
| AUTH-1-11 | next·returnUrl 없음 |
| AUTH-2-02, 7-07~7-09 | 사용자 한 명, 계정 연결 기능 없음 |
| AUTH-2-06, 2-11~2-13, 2.1, 7-03, 7-05 | 자체 계정·복구·OTP 없음, OIDC ID 토큰으로 확인 |
| AUTH-3-14 | Remember me 없음 |
| 4·5번 JWT | 자체 JWT 미발급 |
| 8번 비밀번호 | 비밀번호 미사용 |
| 11번 네이티브 | 웹앱 |
