import type { JsonObject, JsonValue } from '../domain/execution-contract.ts';

/** Present byte boundaries and conceptual packet fields while retaining the full event separately. */
export function WireInspector({ data }: { data: JsonValue }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const wire = (data as JsonObject).wire as JsonObject | undefined;
  if (wire?.kind === 'bytes' && Array.isArray(wire.bytes)) {
    const bytes = wire.bytes as number[];
    const preview = Uint8Array.from(bytes.slice(0, 8192));
    const text = new TextDecoder('utf-8').decode(preview);
    const headerEnd = text.indexOf('\r\n\r\n');
    const length = /(?:^|\r\n)Content-Length:[ \t]*([0-9]+)/i.exec(text)?.[1];
    return (
      <section aria-label='전송 바이트 미리보기' className='wire-preview'>
        <h3>바이트 미리보기 · {bytes.length} bytes</h3>
        {length !== undefined && (
          <p>
            Content-Length: {length} bytes
            {headerEnd >= 0 && bytes.length <= 8192
              ? ` · 실제 본문 ${bytes.length - new TextEncoder().encode(text.slice(0, headerEnd + 4)).length} bytes`
              : ''}
          </p>
        )}
        <pre>{text.replaceAll('\r', '\\r').replaceAll('\n', '\\n\n')}</pre>
        {bytes.length > 8192 && (
          <p>처음 8192바이트만 미리 봅니다. 전체 바이트는 상단 내보내기의 bundle에 있습니다.</p>
        )}
      </section>
    );
  }
  if (
    wire?.kind === 'packet' &&
    wire.packet &&
    typeof wire.packet === 'object' &&
    !Array.isArray(wire.packet)
  ) {
    const fields = (wire.packet as JsonObject).fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
    return (
      <table className='packet-fields'>
        <caption>논리 패킷 필드 · 바이너리 인코딩 아님</caption>
        <tbody>
          {Object.entries(fields).map(([name, value]) => (
            <tr key={name}>
              <th scope='row'>{name}</th>
              <td>{String(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return null;
}
