import "server-only";

import { resolveMetadataBase } from "@/lib/metadata/site";

export function resolveCanonicalAppOrigin(): string {
  const base = resolveMetadataBase() ?? new URL("http://localhost:3000");
  return new URL(base.origin).origin;
}
