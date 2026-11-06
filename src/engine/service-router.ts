import type { StackEndpoint, StackPortEndpoint, StackSnapshot } from '../domain/stack-model.ts';

/** Address an instance by its stable participant/instance tuple, never by display order. */
export function stackEndpointKey(endpoint: StackEndpoint): string {
  return `${endpoint.participant}/${endpoint.instanceId}`;
}

/** Resolve only declared local bindings and the single physical link; no reliability is added. */
export class ServiceRouter {
  readonly #lower = new Map<string, StackPortEndpoint>();
  readonly #upper = new Map<string, StackPortEndpoint>();
  readonly #link: StackSnapshot['configuration']['link'];
  constructor(snapshot: StackSnapshot) {
    this.#link = snapshot.configuration.link;
    for (const binding of snapshot.configuration.bindings) {
      this.#lower.set(stackEndpointKey(binding.consumer), binding.provider);
      this.#upper.set(stackEndpointKey(binding.provider), binding.consumer);
    }
  }
  lower(endpoint: StackEndpoint): StackPortEndpoint | undefined {
    return this.#lower.get(stackEndpointKey(endpoint));
  }
  upper(endpoint: StackEndpoint): StackPortEndpoint | undefined {
    return this.#upper.get(stackEndpointKey(endpoint));
  }
  peer(endpoint: StackEndpoint): StackPortEndpoint {
    const source = this.#link[endpoint.participant];
    if (stackEndpointKey(source) !== stackEndpointKey(endpoint))
      throw new Error('Only a bottom endpoint may use the link');
    return this.#link[endpoint.participant === 'A' ? 'B' : 'A'];
  }
}
