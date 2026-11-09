# Cloudflare 자동 배포

`.github/workflows/cloudflare.yml`이 GitHub Actions에서 실행된다.

- `main` 대상 PR: 의존성 설치 → 테스트 → 빌드
- `main` 푸시: 위 검증 → Cloudflare 배포 → 서비스 HTTP 응답 확인
- Actions의 **Cloudflare CI/CD → Run workflow**: `main`을 선택해 수동 배포
- 검증에 실패하면 배포하지 않는다. 진행 중인 배포는 새 푸시로 취소하지 않는다.

Node.js 24와 `app/package-lock.json`의 의존성을 사용한다. `cf deploy --prebuilt --mode production`으로 검증한 빌드 결과를 배포한다.

## 최초 연결

[저장소 Actions secrets 설정](https://github.com/tpals0409/nahee-s-study-guide/settings/secrets/actions)에 다음 Repository secrets를 등록한다.

| 이름 | 값 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 기존 `hapgyeok-note` Worker를 배포할 수 있는 Cloudflare API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | 해당 Worker가 있는 Cloudflare 계정 ID |

[Cloudflare 공식 GitHub Actions 안내](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)의 Edit Cloudflare Workers 템플릿을 기준으로, 대상 계정과 `leo0409.work` 영역으로 범위를 제한한다. 이 앱은 KV, D1, 사용자 도메인을 사용하므로 해당 리소스의 조회·배포에 필요한 권한도 있어야 한다.

애플리케이션 비밀값 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAIL`, `ANTHROPIC_API_KEY`는 기존 Cloudflare Worker에 등록된 값을 사용한다. `.dev.vars`와 `.secrets.env`를 GitHub에 커밋하지 않는다. 새 Cloudflare 계정으로 이전하는 절차가 아니라 기존 Worker를 갱신하는 배포다.

기존 D1 데이터베이스 ID와 도메인은 `app/cloudflare.config.ts`에 정의되어 있다. SQL 마이그레이션은 이 워크플로에서 자동 실행하지 않는다. 스키마 변경 시 기존 데이터에 대한 영향을 검토해 별도로 적용한다.

## 배포 확인

[Actions 실행 목록](https://github.com/tpals0409/nahee-s-study-guide/actions/workflows/cloudflare.yml)에서 배포 성공을 확인한 뒤 [서비스](https://note.leo0409.work/)에서 Google 로그인을 확인한다. HTTP 확인 단계는 페이지 응답만 검사하며 로그인 성공을 검증하지 않는다.

인증 정보가 누락되면 배포 직전 단계에서 누락된 secret 이름을 표시하고 실패한다. 등록을 마친 뒤 실패한 실행을 재실행하거나 `Run workflow`를 사용한다.

## 자유 질문 챗봇

홈의 AI 질문은 대화를 여러 개 두고 서버에 저장한다(`/api/chats/*`, 마이그레이션 `0003_chats.sql`). 대화와 답변은 D1, 사진은 KV(`chatimg:<메시지 id>`)에 둔다. 질문을 받으면 바로 접수하고, 답변은 Durable Object `ChatRunner`의 알람이 앱과 떨어져 끝까지 만들어 D1에 조금씩 쓴다. 앱은 열린 대화만 0.7초 간격으로 읽는다. 사진은 브라우저에서 JPEG로 축소하며 최대 2장씩 첨부한다. 답변 생성을 위해 텍스트·사진은 Anthropic에 전송된다. 과학 근거 원문은 `python3 collect_science_text.py`로 OpenStax(CC BY 4.0)와 미국 연방 기관 페이지에서 인용 주변 문단만 받아 `data/science/`에 둔다.

`app/build-knowledge.py`가 수집 법령의 시행 구간, 검토된 과학·판례 발췌, 기출 문항과 해설을 서버 전용 검색 자료로 만든다. 질문 분석 단계가 낸 조문 번호는 저장본에서 바로 꺼내고, 그 밖에는 드문 검색어에 가중치를 주는 키워드 검색을 쓴다. 벡터 인덱스는 사용하지 않는다. 부분 해설은 검색 근거에 넣지 않는다. 법령은 질문의 적용일로 버전을 제한하고, 사진 판독이 불명확하면 풀이 대신 확인 질문을 반환한다.

법령 자료는 등록 IP의 Mac에서 `collect_laws.py`로 수집해 빌드에 포함하며 Worker는 법제처 API를 호출하지 않는다. 답변에는 자료의 수집일이 표시되고, 수집일 이후 법령 개정과 판례 변경 여부는 별도 검토 대상이다.
