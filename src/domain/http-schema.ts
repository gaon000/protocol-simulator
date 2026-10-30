import type {
  FieldDefinition,
  MessageDefinition,
  ModelDiagnostic,
  ProtocolDefinition,
} from './protocol-model.ts';

/** Recognize an ASCII HTTP field-name token. */
export function isHttpToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}

/** Return field IDs mapped to the start line or body, rather than ordinary HTTP headers. */
export function httpSpecialIds(message: MessageDefinition): readonly string[] {
  const mapping = message.http;
  if (!mapping) return [];
  return Object.entries(mapping)
    .filter(([key]) => key !== 'kind')
    .map(([, value]) => value);
}

/** List declared headers while reserving Content-Length for byte-derived framing. */
export function httpHeaderFields(message: MessageDefinition): readonly FieldDefinition[] {
  const special = new Set(httpSpecialIds(message));
  return message.fields.filter((field) => !special.has(field.id));
}

/** Validate HTTP binding references and this codec's explicit subset without importing the codec. */
export function httpSchemaDiagnostics(
  protocol: ProtocolDefinition,
  path: string,
): readonly ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const issue = (location: string, message: string) =>
    diagnostics.push({ path: location, code: 'http-schema', message });
  const roles = new Map<string, number>();
  protocol.messages.forEach((message, index) => {
    const location = `${path}/messages/${index}/http`;
    if (protocol.codec !== 'http-1.1') {
      if (message.http) issue(location, 'HTTP mappings require the http-1.1 codec');
      return;
    }
    const mapping = message.http;
    if (!mapping) {
      issue(location, 'HTTP messages require an explicit request, response or raw mapping');
      return;
    }
    roles.set(mapping.kind, (roles.get(mapping.kind) ?? 0) + 1);
    const expected: Record<string, readonly FieldDefinition['type'][]> =
      mapping.kind === 'request'
        ? { methodFieldId: ['enum'], targetFieldId: ['string'], bodyFieldId: ['string'] }
        : mapping.kind === 'response'
          ? { statusFieldId: ['integer'], reasonFieldId: ['string'], bodyFieldId: ['string'] }
          : { wireFieldId: ['string'] };
    for (const [key, id] of Object.entries(mapping)) {
      if (key === 'kind') continue;
      const field = message.fields.find((field) => field.id === id);
      if (!field || !expected[key]?.includes(field.type))
        issue(`${location}/${key}`, `Missing or incompatible HTTP field ${id}`);
      else if (!field.required && field.defaultValue === undefined)
        issue(`${location}/${key}`, 'Mapped HTTP fields must be required or have defaults');
      if (
        field &&
        field.placement !==
          (key === 'bodyFieldId' ? 'body' : key === 'wireFieldId' ? 'payload' : 'header')
      )
        issue(`${location}/${key}`, 'HTTP field placement differs from its mapped role');
    }
    const special = httpSpecialIds(message);
    if (new Set(special).size !== special.length)
      issue(location, 'HTTP start-line/body roles must refer to different fields');
    if (mapping.kind === 'raw') {
      if (message.fields.length !== 1)
        issue(location, 'Raw HTTP has exactly one UTF-8 wire string field');
      return;
    }
    if (mapping.kind === 'request') {
      const method = message.fields.find((field) => field.id === mapping.methodFieldId);
      if (
        method?.type === 'enum' &&
        method.options.some((option) => !['GET', 'POST'].includes(option))
      )
        issue(`${location}/methodFieldId`, 'Only GET and POST are supported');
      const host = httpHeaderFields(message).find((field) => field.name.toLowerCase() === 'host');
      if (host?.type !== 'string' || (!host.required && host.defaultValue === undefined))
        issue(location, 'Requests require a declared Host string header');
    }
    const names = new Set<string>();
    for (const field of httpHeaderFields(message)) {
      const fieldIndex = message.fields.indexOf(field);
      const fieldPath = `${path}/messages/${index}/fields/${fieldIndex}`;
      const name = field.name.toLowerCase();
      if (field.placement !== 'header' || !isHttpToken(field.name))
        issue(fieldPath, 'Ordinary HTTP fields must have valid header names and header placement');
      if (names.has(name))
        issue(`${fieldPath}/name`, 'HTTP header names are case-insensitively unique');
      names.add(name);
      if (
        [
          'content-length',
          'transfer-encoding',
          'content-encoding',
          'connection',
          'upgrade',
          'trailer',
          'te',
          'expect',
        ].includes(name)
      )
        issue(
          `${fieldPath}/name`,
          'This header is derived or unsupported by the limited HTTP codec',
        );
    }
  });
  if (protocol.codec === 'http-1.1')
    for (const role of ['request', 'response'])
      if (roles.get(role) !== 1)
        issue(`${path}/messages`, `HTTP requires exactly one ${role} mapping`);
  return diagnostics;
}
