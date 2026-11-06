import { createHttpCodec } from '../codecs/http-codec.ts';
import {
  createJsonDatagramCodec,
  createJsonLinesCodec,
  type DatagramCodec,
  type JsonLinesCodec,
} from '../codecs/message-codecs.ts';
import type { JsonValue } from '../domain/execution-contract.ts';
import type { ProtocolDefinition, ValidationResult } from '../domain/protocol-model.ts';
import { deserializeBytes, serializeBytes } from '../domain/stack-bytes.ts';
import {
  type StackLimits,
  type StackMessage,
  type StackProtocol,
  stackProtocolBody,
} from '../domain/stack-model.ts';
import {
  validateServicePayload,
  validateStackMessage,
} from '../domain/stack-protocol-validation.ts';
import { EvaluationFault } from './expressions.ts';

/** Unwrap a validated operation as a modeled rule/codec fault, preserving its diagnostic code. */
export function stackValue<T>(result: ValidationResult<T>): T {
  if (result.success) return result.value;
  const first = result.diagnostics[0];
  throw new EvaluationFault(
    first?.code ?? 'invalid-value',
    first?.message ?? 'Invalid runtime value',
  );
}
export type StackDecode = {
  readonly messages: readonly StackMessage[];
  readonly frameBytes: readonly number[];
  readonly diagnostics: readonly { readonly code: string; readonly message: string }[];
};

/** Per-instance codec with a forkable private stream parser and actual consumed frame lengths. */
export class StackCodec {
  readonly #protocol: StackProtocol;
  readonly #limits: StackLimits;
  #stream: JsonLinesCodec | undefined;
  readonly #datagram: DatagramCodec | undefined;
  constructor(protocol: StackProtocol, limits: StackLimits, stream?: JsonLinesCodec) {
    this.#protocol = protocol;
    this.#limits = limits;
    const body = stackProtocolBody(protocol);
    if (body.codec === 'logical-packet') return;
    // Native rules/ports never enter the v1 reader; only this unchanged scalar wire schema does.
    const schema: ProtocolDefinition =
      protocol.mode === 'legacy-application'
        ? protocol.source
        : {
            schemaVersion: 1,
            id: protocol.id,
            revision: protocol.revision,
            label: protocol.label,
            layer: 'application',
            codec: body.codec,
            lowerService: body.codec === 'json-datagram' ? 'datagram' : 'stream',
            messages: body.messages.map((message) => ({
              ...message,
              fields: message.fields.filter((field) => field.type !== 'bytes'),
            })),
            states: [{ id: 'Codec', label: 'Codec' }],
            initialStateId: 'Codec',
            variables: [],
            timers: [],
            rules: [
              {
                id: 'ignore',
                fromStateId: 'Codec',
                nextStateId: 'Codec',
                event: { kind: 'input', messageId: body.messages[0]?.id ?? '' },
                actions: [],
                ignore: true,
              },
            ],
          };
    const codecLimits = {
      maxMessageBytes: limits.maxMessageBytes,
      maxBufferBytes: limits.maxCodecBufferBytes,
    };
    if (body.codec === 'json-datagram')
      this.#datagram = stackValue(createJsonDatagramCodec(schema, codecLimits));
    else
      this.#stream =
        stream ??
        stackValue(
          body.codec === 'http-1.1'
            ? createHttpCodec(schema, codecLimits)
            : createJsonLinesCodec(schema, codecLimits),
        );
  }
  fork(): StackCodec {
    return new StackCodec(this.#protocol, this.#limits, this.#stream?.fork());
  }
  get bufferedBytes(): number {
    return this.#stream?.bufferedBytes() ?? 0;
  }
  encode(message: StackMessage): JsonValue {
    if (this.#stream)
      return serializeBytes(stackValue(this.#stream.encode(message)), this.#limits.maxMessageBytes);
    if (this.#datagram)
      return serializeBytes(
        stackValue(this.#datagram.encode(message)),
        this.#limits.maxMessageBytes,
      );
    const body = stackProtocolBody(this.#protocol);
    const prepared = stackValue(validateStackMessage(body, message, this.#limits.maxMessageBytes));
    const definition = body.messages.find((item) => item.id === prepared.messageId);
    const packet = {
      messageId: prepared.messageId,
      fields: Object.fromEntries(
        definition?.fields.flatMap((field) =>
          Object.hasOwn(prepared.values, field.id) ? [[field.name, prepared.values[field.id]]] : [],
        ) ?? [],
      ),
    };
    return stackValue(
      validateServicePayload(this.#protocol.requires.service, packet, this.#limits.maxMessageBytes),
    );
  }
  receive(payload: JsonValue): StackDecode {
    const checked = stackValue(
      validateServicePayload(
        this.#protocol.requires.service,
        payload,
        this.#limits.maxMessageBytes,
      ),
    );
    if (this.#stream) {
      const decoded = this.#stream.pushTracked(
        stackValue(deserializeBytes(checked, this.#limits.maxMessageBytes)),
      );
      return {
        messages: decoded.messages,
        frameBytes: decoded.frameBytes,
        diagnostics: decoded.diagnostics,
      };
    }
    if (this.#datagram)
      return {
        messages: [
          stackValue(
            this.#datagram.decode(
              stackValue(deserializeBytes(checked, this.#limits.maxMessageBytes)),
            ),
          ),
        ],
        frameBytes: [],
        diagnostics: [],
      };
    const packet = checked as {
      readonly messageId: string;
      readonly fields: Readonly<Record<string, JsonValue>>;
    };
    const body = stackProtocolBody(this.#protocol);
    const message = body.messages.find((item) => item.id === packet.messageId);
    const values = Object.fromEntries(
      message?.fields.flatMap((field) =>
        Object.hasOwn(packet.fields, field.name) ? [[field.id, packet.fields[field.name]]] : [],
      ) ?? [],
    );
    return {
      messages: [
        stackValue(
          validateStackMessage(
            body,
            { messageId: packet.messageId, values },
            this.#limits.maxMessageBytes,
          ),
        ),
      ],
      frameBytes: [],
      diagnostics: [],
    };
  }
  finish(): StackDecode {
    const result = this.#stream?.finish();
    return {
      messages: result?.messages ?? [],
      frameBytes: [],
      diagnostics: result?.diagnostics ?? [],
    };
  }
  abort(): void {
    this.#stream?.abort();
  }
}
