import assert from 'node:assert/strict';
import test from 'node:test';
import type { ValidationResult } from '../../src/domain/protocol-model.ts';
import {
  deserializeBytes,
  OwnedBytes,
  parseBytesValue,
  serializeBytes,
} from '../../src/domain/stack-bytes.ts';
import {
  checkStackExpression,
  evaluateStackExpression,
  parseStackExpression,
} from '../../src/domain/stack-expressions.ts';
import { STACK_POLICY, type StackExpression } from '../../src/domain/stack-model.ts';

function ok<T>(result: ValidationResult<T>): T {
  assert.equal(result.success, true, JSON.stringify(result));
  if (!result.success) throw new Error('Invalid fixture');
  return result.value;
}
const empty = { variables: {}, fields: {} };

test('canonical byte JSON round-trips empty, binary, UTF-8 and a full 1 MiB without sharing storage', () => {
  for (const source of [
    new Uint8Array(),
    Uint8Array.of(0, 127, 128, 255),
    new TextEncoder().encode('가🙂'),
    new Uint8Array(STACK_POLICY.maxMessageBytes).fill(255),
  ]) {
    const original = source.slice();
    const serialized = serializeBytes(source);
    assert.deepEqual(ok(deserializeBytes(JSON.parse(JSON.stringify(serialized)))), original);
    assert.ok(Object.isFrozen(serialized));
    source.fill(42);
    assert.deepEqual(ok(deserializeBytes(serialized)), original);
    const copy = ok(deserializeBytes(serialized));
    copy.fill(0);
    assert.deepEqual(ok(deserializeBytes(serialized)), original);
  }
  assert.throws(() => serializeBytes(new Uint8Array(STACK_POLICY.maxMessageBytes + 1)), RangeError);
});

test('byte parser rejects unknown tags, noncanonical base64, length lies and mutable/non-JSON shapes', () => {
  const valid = serializeBytes(Uint8Array.of(255));
  for (const value of [
    { ...valid, data: '/w' },
    { ...valid, data: '/x==' },
    { ...valid, data: '/w==\n' },
    { ...valid, data: '_w==' },
    { ...valid, data: '!!!!' },
    { ...valid, data: '' },
    { ...valid, encoding: 'hex' },
    { ...valid, byteLength: -1 },
    { ...valid, byteLength: 1.1 },
    { ...valid, byteLength: 2 },
    { ...valid, extra: 0 },
    Uint8Array.of(1),
    Object.defineProperty({}, 'kind', {
      get() {
        throw new Error('Accessor invoked');
      },
      enumerable: true,
    }),
  ])
    assert.equal(parseBytesValue(value).success, false);
  assert.equal(parseBytesValue(valid, 0).success, false);
  assert.throws(() => parseBytesValue(valid, Number.POSITIVE_INFINITY), RangeError);
});

test('owned bytes enforce explicit ranges and return copies for every outward view', () => {
  const input = Uint8Array.of(1, 2, 3);
  const owner = new OwnedBytes(input);
  input[1] = 9;
  const copied = owner.copy();
  copied[1] = 8;
  assert.deepEqual(owner.copy(), Uint8Array.of(1, 2, 3));
  assert.deepEqual(owner.slice(1, 2).copy(), Uint8Array.of(2, 3));
  assert.equal(owner.slice(3, 0).byteLength, 0);
  for (const [offset, length] of [
    [-1, 1],
    [1, -1],
    [3, 1],
    [0.5, 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ])
    assert.throws(() => owner.slice(offset as number, length as number), RangeError);
});

test('typed byte expressions preserve binary data and evaluate byteLength, slice and concat', () => {
  const payload = serializeBytes(Uint8Array.of(0, 255, 128, 1));
  const expression: StackExpression = {
    kind: 'concat',
    values: [
      {
        kind: 'slice',
        value: { kind: 'service-payload' },
        offset: { kind: 'literal', value: 1 },
        length: { kind: 'literal', value: 2 },
      },
      { kind: 'variable', variableId: 'tail' },
      { kind: 'field', fieldId: 'part' },
    ],
  };
  const types = {
    variables: { tail: 'bytes' },
    fields: { part: 'bytes' },
    servicePayload: 'bytes',
  } as const;
  assert.equal(ok(checkStackExpression(expression, types)), 'bytes');
  const context = {
    variables: { tail: serializeBytes(Uint8Array.of(42)) },
    fields: { part: serializeBytes(new Uint8Array()) },
    servicePayload: payload,
  };
  const result = ok(evaluateStackExpression(expression, context));
  assert.deepEqual(ok(deserializeBytes(result)), Uint8Array.of(255, 128, 42));
  assert.equal(ok(evaluateStackExpression({ kind: 'byteLength', value: expression }, context)), 3);
  assert.equal(
    ok(
      evaluateStackExpression(
        {
          kind: 'add',
          left: { kind: 'byteLength', value: expression },
          right: { kind: 'literal', value: 7 },
        },
        context,
      ),
    ),
    10,
  );
});

test('expression type checking rejects wrong operands, missing references and non-payload service events', () => {
  const types = { variables: { scalar: 'integer' }, fields: {} } as const;
  for (const expression of [
    { kind: 'byteLength', value: { kind: 'variable', variableId: 'scalar' } },
    {
      kind: 'slice',
      value: { kind: 'literal', value: serializeBytes(new Uint8Array()) },
      offset: { kind: 'literal', value: '0' },
      length: { kind: 'literal', value: 0 },
    },
    { kind: 'service-payload' },
    { kind: 'field', fieldId: 'missing' },
    { kind: 'variable', variableId: 'toString' },
    { kind: 'concat', values: [{ kind: 'literal', value: '' }] },
  ])
    assert.equal(checkStackExpression(expression, types).success, false);
});

test('dynamic evaluation rejects unsafe arithmetic, ranges, malformed bytes and oversized concat', () => {
  const data = { kind: 'literal', value: serializeBytes(Uint8Array.of(1, 2)) } as const;
  for (const [offset, length] of [
    [-1, 1],
    [1, 2],
    [3, 0],
    [0, -1],
    [0.5, 0],
    [0, Number.MAX_SAFE_INTEGER],
  ]) {
    assert.equal(
      evaluateStackExpression(
        {
          kind: 'slice',
          value: data,
          offset: { kind: 'literal', value: offset },
          length: { kind: 'literal', value: length },
        },
        empty,
      ).success,
      false,
    );
  }
  for (const kind of ['add', 'subtract'] as const)
    assert.equal(
      evaluateStackExpression(
        {
          kind,
          left: { kind: 'literal', value: Number.MAX_SAFE_INTEGER },
          right: { kind: 'literal', value: kind === 'add' ? 1 : -1 },
        },
        empty,
      ).success,
      false,
    );
  assert.equal(
    evaluateStackExpression(
      { kind: 'byteLength', value: { kind: 'variable', variableId: 'bad' } },
      {
        variables: { bad: { kind: 'bytes', encoding: 'base64', data: 'AA==', byteLength: 2 } },
        fields: {},
      },
    ).success,
    false,
  );
  const full = {
    kind: 'literal',
    value: serializeBytes(new Uint8Array(STACK_POLICY.maxMessageBytes)),
  } as const;
  assert.equal(
    evaluateStackExpression({ kind: 'concat', values: [full, data] }, empty).success,
    false,
  );
  assert.equal(
    ok(
      evaluateStackExpression(
        {
          kind: 'slice',
          value: data,
          offset: { kind: 'literal', value: 2 },
          length: { kind: 'literal', value: 0 },
        },
        empty,
      ),
    ) && true,
    true,
  );
});

test('expression parsing bounds depth/nodes/JSON and keeps literal/variable results isolated', () => {
  let deep: StackExpression = { kind: 'literal', value: 0 };
  for (let i = 0; i < 40; i++) deep = { kind: 'byteLength', value: deep };
  assert.equal(parseStackExpression(deep).success, false);
  assert.equal(
    parseStackExpression({
      kind: 'concat',
      values: Array.from({ length: 4096 }, () => ({
        kind: 'literal',
        value: serializeBytes(new Uint8Array()),
      })),
    }).success,
    false,
  );
  for (const input of [
    { kind: 'eval', code: '1' },
    { kind: 'service-payload', extra: 1 },
    { kind: 'concat', values: [] },
    { kind: 'literal' },
  ])
    assert.equal(parseStackExpression(input).success, false);
  const variable = { child: [1] };
  const value = ok(
    evaluateStackExpression(
      { kind: 'variable', variableId: 'value' },
      { variables: { value: variable }, fields: {} },
    ),
  );
  variable.child.push(2);
  assert.deepEqual(value, { child: [1] });
  assert.ok(!Object.isFrozen(variable));
  assert.equal(
    ok(
      evaluateStackExpression(
        { kind: 'variable', variableId: 'value' },
        { variables: { value: null }, fields: {} },
      ),
    ),
    null,
  );
});

test('lower snapshot byte budgets apply to actual operands and concatenation results', () => {
  const data = serializeBytes(Uint8Array.of(1, 2, 3));
  assert.equal(
    evaluateStackExpression({ kind: 'service-payload' }, { ...empty, servicePayload: data }, 2)
      .success,
    false,
  );
  const part = { kind: 'literal', value: serializeBytes(Uint8Array.of(1, 2)) } as const;
  assert.equal(
    evaluateStackExpression({ kind: 'concat', values: [part, part] }, empty, 3).success,
    false,
  );
  assert.equal(evaluateStackExpression({ kind: 'literal', value: 1 }, empty, 0).success, false);
});
