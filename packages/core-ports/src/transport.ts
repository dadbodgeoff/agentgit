import type { RequestEnvelope, ResponseEnvelope } from "@agentgit/schemas";

import type { RequestContext } from "./context.js";

export type TransportHandler = (
  request: RequestEnvelope<unknown>,
  context: RequestContext,
) => Promise<ResponseEnvelope<unknown>>;

export interface TransportListener {
  listen(handler: TransportHandler): Promise<void>;
  close(): Promise<void>;
}
