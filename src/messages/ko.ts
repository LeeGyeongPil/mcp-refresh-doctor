// 한국어 메시지. 키는 en.ts 와 정확히 같아야 한다(타입으로 강제 + 테스트로 재확인).
// 오류 문구에는 검색하기 쉽도록 영어 핵심 구절을 괄호로 함께 남긴다.
import type { MessageKey } from './en.js';

export const ko: Record<MessageKey, string> = {
  // ── 도움말 ──────────────────────────────────────────────────────────
  help: `mcp-refresh-doctor — 원격 MCP 서버가 왜 자꾸 다시 로그인하라고 하는지 진단합니다.

사용법 (Usage):
  mcp-refresh-doctor check <MCP 주소> [옵션]       서버에 토큰 수명주기를 실제로 돌려 봅니다
  mcp-refresh-doctor serve --preset <이름>         연습용 목(mock) 서버를 띄웁니다(고장 프리셋)
  mcp-refresh-doctor demo [--json]                 프리셋 전부를 오프라인으로 점검해 판정을 보여 줍니다

check 옵션:
  --client-id <id>       동적 등록 대신 미리 등록한 공개 클라이언트를 씁니다
  --redirect-port <n>    루프백 콜백 포트(--client-id 와 함께 필요)
  --scope <스코프>       요청 스코프를 직접 지정합니다
  --wait-expiry          액세스 토큰이 실제로 만료될 때까지 기다렸다가 응답을 확인합니다(C15)
  --max-wait <초>        --wait-expiry 대기 상한(기본 3700)
  --timeout <초>         요청마다 시간 제한(기본 15)
  --allow-http           루프백이 아닌 호스트에도 평문 http 를 허용합니다(권장하지 않음)
  --auto-consent         브라우저 없이 authorize 리다이렉트를 따라갑니다(루프백 시험 서버 전용)
  --json                 JSON 보고서를 표준 출력으로 냅니다
  --out <파일>           JSON 보고서를 파일로도 씁니다

serve 옵션:
  --preset <이름>        good | no-refresh | expired-403 | no-rotation | refresh-needs-secret | resource-required
  --port <n>             127.0.0.1 에서 들을 포트(기본 8787, 0 = 임의)
  --ttl <초>             액세스 토큰 수명(기본 3600)

공통:
  --lang en|ko           출력 언어(또는 MCP_REFRESH_DOCTOR_LANG, 그다음 LC_ALL/LC_MESSAGES/LANG)
  -h, --help             이 도움말
  -v, --version          버전

종료 코드: 0 = 서버는 갱신 준비 완료(클라이언트 쪽 원인), 1 = 서버 쪽 원인 발견,
           2 = 판정 불가 또는 사용법 오류.`,

  // ── 검사 제목 ───────────────────────────────────────────────────────
  'title.C01': '토큰 없는 요청에 401 + WWW-Authenticate',
  'title.C02': '보호 자원 메타데이터(RFC 9728)',
  'title.C03': '인가 서버가 refresh_token grant 를 광고(RFC 8414)',
  'title.C04': '인가 서버의 offline_access 광고',
  'title.C05': '동적 클라이언트 등록이 refresh_token 을 유지(RFC 7591)',
  'title.C06': '코드 교환에서 갱신 토큰 발급(PKCE S256)',
  'title.C07': '액세스 토큰의 expires_in',
  'title.C08': '첫 액세스 토큰으로 MCP initialize',
  'title.C09': 'resource 를 실은 갱신(RFC 8707)',
  'title.C10': 'resource 없는 갱신',
  'title.C11': '갱신 토큰 회전',
  'title.C12': '갱신된 액세스 토큰으로 MCP initialize',
  'title.C13': '무효 토큰에 401 invalid_token(RFC 6750)',
  'title.C14': '회전 전 갱신 토큰 재사용을 거부',
  'title.C15': '실제로 만료된 토큰에 401 invalid_token',

  // ── 검사 결과 설명 ──────────────────────────────────────────────────
  'c01.ok': '401, resource_metadata={url}',
  'c01.not_401': '401 대신 HTTP {status} — 이 엔드포인트는 OAuth 를 요구하지 않습니다',
  'c01.no_resource_metadata': '401 이지만 WWW-Authenticate 에 resource_metadata 가 없음(well-known 주소로 대신 찾음)',
  'c02.unreadable': '어느 well-known 주소에서도 보호 자원 메타데이터를 읽지 못함',
  'c02.incomplete': '메타데이터에 "resource" 또는 "authorization_servers" 가 없음',
  'c02.offline_access_in_prm': '자원 메타데이터 scopes 에 offline_access 가 있음(SEP-2207: 인가 서버에만 둘 것)',
  'c02.ok': 'resource={resource}',
  'c03.unreadable': '인가 서버 메타데이터를 읽지 못함(RFC 8414 / OIDC discovery)',
  'c03.missing': 'grant_types_supported 가 없음 — 갱신 지원을 광고하지 않음',
  'c03.no_refresh': 'grant_types_supported 가 "{grants}" — refresh_token 없음',
  'c03.ok': 'grant_types_supported 에 refresh_token 있음',
  'c04.advertised': 'scopes_supported 에 offline_access 있음 — 요청 스코프에 덧붙임',
  'c04.not_advertised': 'offline_access 를 광고하지 않음(서버가 갱신 토큰 발급에 요구하지 않는다면 괜찮음)',
  'c05.unsupported': 'registration_endpoint 가 없음 — 미리 등록한 공개 클라이언트를 --client-id 로 주세요',
  'c05.failed': '등록 실패(HTTP {status}, {error})',
  'c05.confidential': '서버가 기밀 클라이언트({method})로 등록함 — 공개 클라이언트 시험 불가',
  'c05.no_grant_types': '등록됐지만 응답에 grant_types 가 없음(RFC 7591 은 그대로 돌려주라고 함)',
  'c05.dropped_refresh': '등록됐지만 grant_types 가 "{grants}" 로 바뀜 — refresh_token 이 빠짐',
  'c05.ok': '시험용 클라이언트를 authorization_code + refresh_token 으로 등록',
  'c05.client_id_given': '--client-id 로 받은 클라이언트를 사용',
  'c06.exchange_failed': '코드 교환 실패(HTTP {status}, {error})',
  'c06.ok': '액세스 토큰과 갱신 토큰 발급',
  'c06.no_refresh_token': '액세스 토큰만 발급, 갱신 토큰 없음 — 만료되면 사용자가 다시 로그인해야 함',
  'c07.missing': 'expires_in 없음 — 클라이언트가 만료 전에 미리 갱신할 수 없음',
  'c07.short': 'expires_in={seconds}초(5분 미만)',
  'c07.ok': 'expires_in={seconds}초',
  'c08.ok': 'initialize + tools/list 성공(도구 {tools}개)',
  'c08.failed': '{step} 실패(HTTP {status}, {error})',
  'c09.ok': '새 액세스 토큰 발급',
  'c09.failed': '갱신 실패(HTTP {status}, {error})',
  'c10.ok': 'resource 없이도 갱신됨',
  'c10.invalid_target': 'invalid_target — 갱신 때 resource 를 빠뜨리는 클라이언트는 실패함',
  'c10.failed': 'resource 없는 갱신 실패(HTTP {status}, {error})',
  'c11.rotated': '새 갱신 토큰이 발급됐고 이전 것과 다름',
  'c11.same_token': '같은 갱신 토큰을 돌려줌(회전 없음)',
  'c11.not_returned': '새 갱신 토큰을 주지 않음(회전 없음)',
  'c12.ok': 'initialize + tools/list 성공(도구 {tools}개)',
  'c12.failed': '갱신된 토큰으로 {step} 실패(HTTP {status}, {error})',
  'c13.ok': '401 + Bearer error="invalid_token"',
  'c13.no_error': '401 이지만 WWW-Authenticate 에 error="invalid_token" 없음(error={error})',
  'c13.wrong_status': '{status} 응답 — 클라이언트는 401 에서만 갱신을 시작함',
  'c14.ok': 'invalid_grant 로 거부(재사용 감지 동작)',
  'c14.reuse_accepted': '이전 갱신 토큰이 아직 통함(재사용 감지 없음)',
  'c14.other_rejection': '거부했지만 invalid_grant 가 아니라 HTTP {status} {error}',
  'c15.ok': '만료 토큰: 401 + Bearer error="invalid_token"',
  'c15.no_error': '만료 토큰: 401 이지만 error="invalid_token" 없음(error={error})',
  'c15.wrong_status': '만료 토큰: {status} 응답 — 클라이언트는 401 에서만 갱신을 시작함',

  // ── 건너뛴 이유 ─────────────────────────────────────────────────────
  'skip.not_reached': '진행하지 못함(앞 단계에서 멈춤)',
  'skip.no_refresh_token': '건너뜀: 갱신 토큰이 발급되지 않음',
  'skip.refresh_failed': '건너뜀: 갱신 실패',
  'skip.no_rotation': '건너뜀: 시험할 회전이 없음',
  'skip.c15_not_requested': '건너뜀: 실제 만료까지 기다리려면 --wait-expiry',
  'skip.c15_no_expires_in': '건너뜀: 기다릴 expires_in 이 없음',
  'skip.c15_too_long': '건너뜀: 만료까지 {seconds}초(--max-wait 초과)',
  'skip.no_response': '서버 응답 없음({error}) — 서버 결함의 증거가 아님',

  // ── 진행 불가(판정 불가) 이유 ───────────────────────────────────────
  'blocked.network': '{url} 에 연결하지 못함({error})',
  'blocked.not_protected': '토큰 없이도 MCP 엔드포인트가 HTTP {status} 로 답해 시험할 OAuth 흐름이 없음',
  'blocked.no_prm': '쓸 수 있는 보호 자원 메타데이터가 없어 인가 서버를 알 수 없음',
  'blocked.insecure_url': '평문 http 엔드포인트 {url} 거부(refusing plain http; 필요하면 --allow-http)',
  'blocked.no_as_metadata': '{issuer} 의 인가 서버 메타데이터를 읽지 못함',
  'blocked.as_incomplete': '인가 서버 메타데이터에 authorization_endpoint 또는 token_endpoint 가 없음',
  'blocked.registration': '동적 클라이언트 등록으로 client id 를 받지 못함',
  'blocked.confidential': '서버가 기밀 클라이언트만 등록함(아직 지원하지 않음)',
  'blocked.auto_consent_remote': '--auto-consent 는 루프백 인가 서버에서만 동작',
  'blocked.auto_consent_failed': '자동 동의가 콜백까지 닿지 못함({error})',
  'blocked.login_timeout': '로그인 시간 초과 — 콜백이 오지 않음',
  'blocked.login_denied': '인가 서버가 콜백으로 오류를 돌려줌({error})',
  'blocked.login_state_mismatch': '콜백의 state 가 맞지 않음(오래된 브라우저 탭일 수 있음)',
  'blocked.login_no_code': '콜백에 인가 코드가 없음',
  'blocked.login_closed': '콜백이 오기 전에 로그인 대기를 멈춤',
  'blocked.callback_port': '{port} 번 포트에 루프백 콜백을 열지 못함({error})',
  'blocked.no_response': '{check} 요청이 응답을 받지 못함({error}) — 네트워크 실패·시간 초과는 갱신에 대해 아무것도 증명하지 않음',

  // ── 고칠 설정 ───────────────────────────────────────────────────────
  'hint.c01_return_401': 'MCP 엔드포인트를 보호하세요: 토큰 없는 요청에는 401 과 Bearer WWW-Authenticate 도전을 돌려줍니다.',
  'hint.c01_resource_metadata': '401 의 WWW-Authenticate 헤더에 resource_metadata="<PRM 주소>" 를 넣으세요(RFC 9728 §5.1).',
  'hint.c02_publish_prm': '/.well-known/oauth-protected-resource[/경로] 에서 "resource" 와 "authorization_servers" 를 제공하세요.',
  'hint.c02_offline_access': '자원 메타데이터 scopes_supported 에서 offline_access 를 빼고 인가 서버 메타데이터에 광고하세요(SEP-2207).',
  'hint.c03_advertise': '인가 서버 메타데이터에 "grant_types_supported": ["authorization_code", "refresh_token"] 를 넣으세요.',
  'hint.c03_enable_refresh': '공개 클라이언트에도 refresh_token grant 를 켜고 grant_types_supported 에 넣으세요.',
  'hint.c04_offline_access': '인가 서버가 offline_access 일 때만 갱신 토큰을 준다면 scopes_supported 에 offline_access 를 넣어 클라이언트가 요청하게 하세요.',
  'hint.c05_use_client_id': '공개 클라이언트(token_endpoint_auth_method "none", grant authorization_code + refresh_token)를 등록하고 --client-id 와 --redirect-port 로 주세요.',
  'hint.c05_keep_refresh': '동적 등록 클라이언트가 요청한 grant_types(refresh_token 포함)를 유지하고 응답에 그대로 돌려주세요.',
  'hint.c06_issue_refresh': 'refresh_token grant 로 등록한 공개 클라이언트(그리고 offline_access 로 제한한다면 그 요청)에 갱신 토큰을 발급하세요.',
  'hint.c07_expires_in': '모든 액세스 토큰에 expires_in 을 주고, 수명은 충분히(수 분~수 시간) 두세요.',
  'hint.c08_accept_token': 'MCP 서버는 자기 resource 용으로 발급된 액세스 토큰을 받아야 합니다(audience·resource 검증 확인).',
  'hint.c11_rotate': '공개 클라이언트의 갱신 토큰은 쓸 때마다 회전하거나(OAuth 2.1 §4.3.1) 발신자에 묶으세요.',
  'hint.c12_accept_refreshed': '갱신된 토큰도 원래 토큰과 같은 audience·resource 를 가져야 합니다 — refresh grant 가 audience 를 어떻게 정하는지 확인하세요.',
  'hint.invalid_token_header': '401 의 WWW-Authenticate 헤더에 error="invalid_token" 을 넣어 클라이언트가 갱신해야 함을 알게 하세요.',
  'hint.expired_must_be_401': '만료·무효 토큰에는 403·5xx 가 아니라 401 + WWW-Authenticate: Bearer error="invalid_token" 으로 답하세요(RFC 6750 §3.1).',
  'hint.c14_reuse_detection': '갱신 토큰 재사용을 감지하세요: 이미 쓴 갱신 토큰이 다시 오면 invalid_grant 로 거부하고 같은 승인에서 발급된 갱신 토큰을 모두 폐기합니다.',
  'hint.c14_invalid_grant': '재사용된 갱신 토큰은 400 invalid_grant 로 거부하세요(RFC 6749 §5.2).',
  'hint.token.invalid_client': '코드 교환은 공개 클라이언트로 받아 주면서 갱신에서만 클라이언트 인증을 요구합니다 — 갱신에도 token_endpoint_auth_method "none" 을 허용하세요.',
  'hint.token.invalid_grant': '인가 서버가 쓰지 않은 새 갱신 토큰을 거부했습니다 — 갱신 토큰 수명·폐기·바인딩 정책을 확인하세요.',
  'hint.token.invalid_scope': '갱신에서 스코프를 거부합니다 — 스코프 없는 갱신(원래 스코프 의미)이나 같은 스코프를 받아 주세요.',
  'hint.token.invalid_target': 'resource 매개변수(RFC 8707)가 있는 갱신을 받아 주세요. 필수로 요구해도 표준 클라이언트엔 괜찮지만 빠뜨리는 클라이언트는 실패합니다.',
  'hint.token.unsupported_grant_type': '토큰 엔드포인트에서 refresh_token grant 를 켜세요.',
  'hint.token.server_error': '갱신에 5xx 를 돌려줍니다 — 많은 클라이언트가 이를 "다시 로그인"으로 처리합니다. 인가 서버 로그를 확인하세요.',
  'hint.token.non_json': '토큰 엔드포인트는 오류일 때도 JSON 본문(application/json)으로 답해야 합니다(RFC 6749 §5.1–5.2).',
  'hint.token.network': '토큰 엔드포인트에 닿지 못했습니다 — 네트워크·TLS·시간 제한(--timeout)을 확인하세요.',
  'hint.token.other': '토큰 엔드포인트가 예상 밖의 오류로 거부했습니다 — JSON 보고서의 근거를 확인하세요.',
  'hint.blocked.discovery': '발견 단계가 끝나지 않아 갱신에 대해 증명된 것이 없습니다. 주소·네트워크·서버 메타데이터 문서를 확인하세요.',
  'hint.blocked.registration': '등록이 끝나지 않았습니다. --client-id <공개 클라이언트 id> --redirect-port <포트> 로 다시 실행하세요.',
  'hint.blocked.login': '로그인이 끝나지 않았습니다. 출력된 주소를 브라우저로 열어 5분 안에 로그인하세요.',
  'hint.blocked.tokens': '로그인 뒤 요청이 응답을 받지 못해(네트워크 오류·시간 초과) 남은 검사를 하지 않았습니다. 다시 실행하고, 느린 네트워크라면 --timeout 을 늘리세요.',
  'hint.client_side': '서버 쪽은 갱신 준비가 된 것으로 보입니다. 그래도 재로그인이 반복되면 클라이언트를 확인하세요: 회전된 갱신 토큰을 저장하는지, 갱신 때 resource 를 보내는지, 새 액세스 토큰을 전송 계층에 쓰는지. 이 JSON 보고서를 클라이언트 이슈에 첨부하세요.',

  // ── 판정·보고서 ─────────────────────────────────────────────────────
  'verdict.label.server': '서버 원인',
  'verdict.label.client': '클라이언트 원인',
  'verdict.label.inconclusive': '판정 불가',
  'verdict.server': '서버가 조용한 토큰 갱신을 지원하지 못합니다 — 사용자는 다시 로그인하라는 요청을 받게 됩니다.',
  'verdict.client': '서버는 갱신 준비가 됐습니다. 반복되는 재로그인은 클라이언트 쪽 문제일 가능성이 높습니다.',
  'verdict.inconclusive': '검사를 끝내지 못해 아직 원인을 말할 수 없습니다.',
  'report.title': 'mcp-refresh-doctor — {target}',
  'report.verdict': '판정',
  'report.reasons': '근거',
  'report.fixes': '고칠 설정',
  'report.blocked': '{stage} 단계에서 멈춤',
  'report.duration': '{seconds}초 걸림',
  'stage.discovery': '발견',
  'stage.registration': '등록',
  'stage.login': '로그인',
  'stage.tokens': '토큰 점검',
  'report.wrote': 'JSON 보고서를 {file} 에 저장했습니다',

  // ── 진행 표시(표준 오류) ────────────────────────────────────────────
  'progress.login_url': '한 번 로그인하도록 브라우저를 엽니다. 열리지 않으면 이 주소를 직접 여세요:',
  'progress.waiting_login': '로그인 콜백을 기다리는 중(최대 5분)...',
  'progress.waiting_expiry': '액세스 토큰이 실제로 만료되도록 {seconds}초 기다리는 중(--wait-expiry)...',
  'callback.page': 'mcp-refresh-doctor 가 로그인을 받았습니다. 이 탭을 닫고 터미널로 돌아가세요.',

  // ── demo ────────────────────────────────────────────────────────────
  'demo.banner': '연습용 목(mock) 서버(로컬·오프라인) — 보고된 고장 증상을 재현할 뿐, 특정 회사의 실제 서버가 아닙니다.',
  'demo.col_preset': '프리셋',
  'demo.col_verdict': '판정',
  'demo.col_findings': '발견 사항',
  'demo.all_pass': '전부 PASS',
  'demo.expected_ok': '기대와 같음',
  'demo.expected_bad': '예상 밖(기대: {expected})',
  'demo.summary': '프리셋 {total}개 중 {ok}개가 기대 판정과 같았습니다.',

  // ── serve ───────────────────────────────────────────────────────────
  'serve.banner': '연습용 목(mock) MCP 서버 + 인가 서버(프리셋 "{preset}") — 갱신 처리를 시험하는 로컬 대역일 뿐, 특정 회사의 실제 서버가 아닙니다.',
  'serve.listening': 'MCP 엔드포인트: {url}',
  'serve.ttl': '액세스 토큰 수명 {ttl}초. 로그인은 자동 승인됩니다. 멈추려면 Ctrl+C.',

  // ── 오류 ────────────────────────────────────────────────────────────
  'error.plain_http': '오류: 루프백이 아닌 호스트로의 평문 http 를 거부합니다(refusing plain http) — 필요하면 --allow-http',
  'error.invalid_url': '오류: 올바른 http(s) 주소가 아닙니다: {url}',
  'error.auto_consent_remote': '오류: --auto-consent 는 루프백 호스트(127.0.0.1, localhost, ::1)에서만 쓸 수 있습니다',
  'error.unknown_command': '오류: 알 수 없는 명령 "{cmd}"(--help 참고)',
  'error.missing_url': '오류: check 에는 MCP 서버 주소가 필요합니다(--help 참고)',
  'error.unknown_preset': '오류: 알 수 없는 프리셋 "{name}"(다음 중 하나: {list})',
  'error.bad_number': '오류: {opt} 에는 0 이상의 숫자가 필요합니다',
  'error.bad_lang': '오류: --lang 은 en 또는 ko 여야 합니다',
  'error.args': '오류: {message}',
  'error.unknown_option': '오류: 알 수 없는 옵션 {name}. --help 로 지원하는 옵션을 확인하세요.',
  'error.option_value': '오류: {name} 옵션에는 값이 필요합니다. 바로 뒤에 값을 적어 주세요(예: {name} <값>).',
  'error.client_id_needs_port': '오류: --client-id 는 --redirect-port <포트> 와 함께 써야 합니다(미리 등록한 루프백 리디렉션 URI 의 포트).',
  'report.write_failed': '경고: 보고서를 {file} 에 저장하지 못했습니다({reason}). 폴더를 만들거나 다른 --out 경로를 쓰세요. 판정 종료 코드는 그대로입니다.',
};
