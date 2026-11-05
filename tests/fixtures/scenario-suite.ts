import { createScenarioSuite } from '../../src/application/scenario-suites.ts';
import { createDraftRecord } from '../../src/application/workspace-operations.ts';
import type { DraftRecord } from '../../src/domain/workspace-model.ts';
import { createExampleCopy } from '../../src/examples/catalog.ts';

/** Capture three real stop-and-wait cases sharing the same current protocol definition. */
export function createSuiteDraft(): DraftRecord {
  const draft = createDraftRecord(createExampleCopy('stop_wait'));
  const suite = createScenarioSuite(draft);
  const normal = suite.cases[0];
  if (normal?.environment.kind !== 'datagram') throw new Error('Missing datagram case');
  return {
    ...draft,
    suite: {
      ...suite,
      cases: [
        { ...normal, label: '정상 전송' },
        {
          ...structuredClone(normal),
          id: 'case_ack_loss',
          label: 'ACK 손실',
          environment: {
            ...normal.environment,
            targetedDrops: [{ direction: 'BtoA', transmission: 1 }],
          },
        },
        {
          ...structuredClone(normal),
          id: 'case_duplicate',
          label: '중복 수신',
          environment: {
            ...normal.environment,
            directions: {
              ...normal.environment.directions,
              AtoB: { ...normal.environment.directions.AtoB, duplicateRate: 1 },
            },
          },
        },
      ],
    },
  };
}
