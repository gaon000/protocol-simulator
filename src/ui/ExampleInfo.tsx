import type { ExperimentDefinition } from '../domain/protocol-model.ts';
import { EXAMPLES, type Example } from '../examples/catalog.ts';

/** Show provenance, supported behavior and omissions beside every editable example copy. */
export function ExampleDetails({ example }: { example: Example }) {
  return (
    <details className='example-details'>
      <summary>출처·지원 범위 · v{example.version}</summary>
      <p>{example.expected}</p>
      <h3>지원</h3>
      <ul>
        {example.supported.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <h3>생략·제한</h3>
      <ul>
        {example.omitted.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>
        {example.sources.length
          ? example.sources.map((source) => (
              <a key={source.url} href={source.url} target='_blank' rel='noreferrer'>
                {source.title}
              </a>
            ))
          : '이 프로젝트의 사용자 정의 모델 · 표준 규격 아님'}
      </p>
      <p>원본은 보존됩니다. 편집과 실행은 사용자 정의 사본에서 수행합니다.</p>
    </details>
  );
}

/** Keep source identity visible even for an imported copy whose catalog version is unavailable. */
export function ExampleOrigin({ experiment }: { experiment: ExperimentDefinition }) {
  if (!experiment.origin) return null;
  const example = EXAMPLES.find(
    (item) =>
      item.id === experiment.origin?.exampleId && item.version === experiment.origin.version,
  );
  return (
    <section className='origin-note' aria-label='원본 예제 정보'>
      <p>
        사용자 정의 사본 · {example?.title ?? experiment.origin.exampleId} · 원본 v
        {experiment.origin.version}
      </p>
      {example ? (
        <ExampleDetails example={example} />
      ) : (
        <p>이 버전의 원본 설명은 현재 라이브러리에 없습니다.</p>
      )}
    </section>
  );
}
