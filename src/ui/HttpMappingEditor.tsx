import type { MessageDefinition } from '../domain/protocol-model.ts';
import { Control, Group, useEditor } from './forms.tsx';

/** Map editable stable field IDs to HTTP start-line/body roles without hard-coded field names. */
export function HttpMappingEditor({ message, path }: { message: MessageDefinition; path: string }) {
  const { edit } = useEditor();
  const mapping = message.http;
  const ids = message.fields.map((field) => field.id);
  return (
    <Group path={`${path}/http`} title='HTTP wire 연결'>
      <label className='control'>
        <span>HTTP 메시지 종류</span>
        <select
          data-path={`${path}/http/kind`}
          value={mapping?.kind ?? ''}
          onChange={(event) => {
            const kind = event.target.value;
            edit(
              `${path}/http`,
              kind === 'request'
                ? {
                    kind,
                    methodFieldId: ids[0] ?? '',
                    targetFieldId: ids[1] ?? '',
                    bodyFieldId: ids[2] ?? '',
                  }
                : kind === 'response'
                  ? {
                      kind,
                      statusFieldId: ids[0] ?? '',
                      reasonFieldId: ids[1] ?? '',
                      bodyFieldId: ids[2] ?? '',
                    }
                  : { kind: 'raw', wireFieldId: ids[0] ?? '' },
            );
          }}
        >
          <option value=''>선택</option>
          <option value='request'>요청</option>
          <option value='response'>응답</option>
          <option value='raw'>원시 UTF-8 오류 실험</option>
        </select>
      </label>
      {mapping &&
        Object.keys(mapping)
          .filter((key) => key !== 'kind')
          .map((key) => (
            <Control key={key} path={`${path}/http/${key}`} label={key} options={ids} />
          ))}
      <p className='hint'>
        {mapping?.kind === 'raw'
          ? '문자열을 그대로 전송합니다. JSON 문자열의 \\r\\n으로 CRLF를 유지하세요. 수신 측은 일반 HTTP 코덱으로 파싱합니다.'
          : '남은 header 필드는 HTTP 헤더입니다. Content-Length는 본문 UTF-8 바이트 수로 자동 생성하며 실제 전송 상세에서 확인합니다.'}
      </p>
    </Group>
  );
}
