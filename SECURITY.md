# 보안 정책 / Security policy

보안 취약점을 발견하셨다면 **공개 이슈 대신** 이 레포의 **Security → Report a vulnerability**(비공개 취약점 신고)로 알려 주세요. 확인 후 답변드리고, 고친 버전을 릴리스하면서 함께 안내합니다.

If you find a security issue, please **do not open a public issue**. Use **Security → Report a vulnerability** in this repository to report it privately. We will reply after checking and announce the fix with a release.

이 도구는 진단용 CLI 입니다. `serve` 와 로그인 콜백은 127.0.0.1 에서만 접속을 받고, `check` 는 `--allow-http` 가 없으면 루프백이 아닌 호스트로의 평문 http 를 거부하며, 리포트와 로그는 토큰·코드·`client_id` 를 가립니다. / This is a diagnostic CLI: `serve` and the login callback bind 127.0.0.1 only, `check` refuses plain http to non-loopback hosts unless `--allow-http` is given, and reports and logs mask tokens, codes and `client_id`.
