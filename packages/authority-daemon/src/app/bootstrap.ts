import { AuthorityService } from "./authority-service.js";
import { createLocalStores, type StartServerOptions } from "../stores/local-store-factory.js";

export interface BootstrappedDaemon {
  service: AuthorityService;
  cleanup: () => Promise<void>;
}

export async function bootstrapLocalDaemon(options: StartServerOptions): Promise<BootstrappedDaemon> {
  const { deps, serviceOptions, cleanup } = await createLocalStores(options);
  const service = new AuthorityService(deps, serviceOptions);
  service.rehydrate();
  service.recoverInterrupted();
  deps.journal.enforceArtifactRetention();
  deps.hostedExecutionQueue.start();
  return { service, cleanup };
}
