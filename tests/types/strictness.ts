import { createRunSnapshot } from '../../src/domain/execution-contract.ts';

// @ts-expect-error strictNullChecks must reject null as a string.
const missingText: string = null;
// @ts-expect-error noImplicitAny must reject an untyped argument.
const identity = (value) => value;
// @ts-expect-error noUncheckedIndexedAccess must include undefined.
const missingItem: number = [1][2];
// @ts-expect-error exactOptionalPropertyTypes must distinguish absent from undefined.
const optionalValue: { label?: string } = { label: undefined };

void [missingText, identity, missingItem, optionalValue];

const snapshot = createRunSnapshot({ environment: { delayMs: 10 } }, 0);
// @ts-expect-error snapshot settings must remain deeply readonly.
snapshot.configuration.environment.delayMs = 20;
