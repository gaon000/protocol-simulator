import type { JsonValue } from '../domain/execution-contract.ts';
import { equalJson } from './expressions.ts';

/** Select candidate rules in declaration order; visit only direct state/event matches. */
export function matchingRules<
  Event extends JsonValue,
  Rule extends { readonly id: string; readonly fromStateId: string; readonly event: Event },
>(
  rules: readonly Rule[],
  stateId: string,
  event: Event,
  guard: (rule: Rule) => boolean,
  visit: (rule: Rule) => void = () => {},
): Rule[] {
  return rules.filter((rule) => {
    if (rule.fromStateId !== stateId || !equalJson(rule.event, event)) return false;
    visit(rule);
    return guard(rule);
  });
}
