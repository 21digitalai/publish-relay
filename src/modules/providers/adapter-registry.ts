import type { DestinationProvider, PublishingAdapter } from './contract.js';

export class PublishingAdapterRegistry<TAdapter extends PublishingAdapter = PublishingAdapter> {
  private readonly adapters: ReadonlyMap<DestinationProvider, TAdapter>;

  public constructor(adapters: readonly TAdapter[]) {
    const byDestination = new Map<DestinationProvider, TAdapter>();
    for (const adapter of adapters) {
      if (byDestination.has(adapter.destinationProvider)) {
        throw new Error(`Publishing adapter already registered: ${adapter.destinationProvider}`);
      }
      byDestination.set(adapter.destinationProvider, adapter);
    }
    this.adapters = byDestination;
  }

  public get(destinationProvider: DestinationProvider): TAdapter {
    const adapter = this.adapters.get(destinationProvider);
    if (!adapter) {
      throw new Error(`Publishing adapter is not registered: ${destinationProvider}`);
    }
    return adapter;
  }
}
