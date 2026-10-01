import { PublishingAdapterRegistry } from './adapter-registry.js';
import type { DestinationProvider } from './contract.js';

export interface DestinationDispatchAdapter {
  readonly destinationProvider: DestinationProvider;
  dispatch(): Promise<number>;
  reconcile(): Promise<number>;
}

export async function runDestinationDispatchCycle(
  adapters: readonly DestinationDispatchAdapter[],
): Promise<
  readonly { destinationProvider: DestinationProvider; phase: 'reconcile' | 'dispatch' }[]
> {
  const registry = new PublishingAdapterRegistry(adapters);
  const failures: { destinationProvider: DestinationProvider; phase: 'reconcile' | 'dispatch' }[] =
    [];
  for (const destinationProvider of registry.destinations()) {
    const adapter = registry.get(destinationProvider);
    try {
      await adapter.reconcile();
    } catch {
      failures.push({ destinationProvider, phase: 'reconcile' });
      continue;
    }
    try {
      await adapter.dispatch();
    } catch {
      failures.push({ destinationProvider, phase: 'dispatch' });
    }
  }
  return failures;
}
