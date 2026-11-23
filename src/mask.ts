// 토큰·인가 코드·client_id 가리기.
// 보고서·로그에는 "앞 3자 + … + 끝 2자"만 남긴다. 짧은 값은 아예 보여 주지 않는다.

export function maskValue(value: string): string {
  if (value.length < 8) return '…';
  return `${value.slice(0, 3)}…${value.slice(-2)}`;
}

// 실행 중 본 비밀 값을 모아 두었다가, 최종 출력 문자열에서 한꺼번에 가린다.
// (서버가 오류 본문에 토큰을 그대로 되돌려 주는 경우까지 막기 위한 이중 안전장치)
export class Redactor {
  private readonly secrets = new Set<string>();

  add(value: string | undefined | null): void {
    // 너무 짧은 값은 일반 단어와 겹칠 수 있어 등록하지 않는다(그런 값은 maskValue 가 이미 '…' 로 만든다).
    if (typeof value === 'string' && value.length >= 4) this.secrets.add(value);
  }

  mask(value: string | undefined | null): string | undefined {
    if (typeof value !== 'string') return undefined;
    this.add(value);
    return maskValue(value);
  }

  scrub(text: string): string {
    // 긴 값부터 바꿔야 한 비밀이 다른 비밀의 일부일 때도 원문이 남지 않는다.
    const ordered = [...this.secrets].sort((a, b) => b.length - a.length);
    let out = text;
    for (const secret of ordered) out = out.split(secret).join(maskValue(secret));
    // JSON 직렬화가 '/' 등을 이스케이프한 형태로도 한 번 더 찾는다.
    for (const secret of ordered) {
      const escaped = JSON.stringify(secret).slice(1, -1);
      if (escaped !== secret) out = out.split(escaped).join(maskValue(secret));
    }
    return out;
  }
}
