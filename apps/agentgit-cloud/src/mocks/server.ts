import { setupServer } from "msw/node";

import { cloudHandlers } from "@/mocks/handlers";

export const server = setupServer(...cloudHandlers);
