import { PublishingAdapterRegistry } from './adapter-registry.js';
import type { DestinationProvider } from './contract.js';

export interface DestinationDispatchAdapter {
  readonly destinationProvider: DestinationProvider;
  dispatch(): Promise<number>;
  reconcile(): Promise<number>;
}

export async function runDestinationDispatchCycle(
  adapters: readonly DestinationDispatchAdapter[],
): Promise<void> {
  const registry = new PublishingAdapterRegistry(adapters);
  for (const destinationProvider of registry.destinations()) {
    const adapter = registry.get(destinationProvider);
    await adapter.reconcile();
    await adapter.dispatch();
  }
}
