import { setupWorker } from "msw/browser";

import { cloudHandlers } from "@/mocks/handlers";

export const worker = setupWorker(...cloudHandlers);
