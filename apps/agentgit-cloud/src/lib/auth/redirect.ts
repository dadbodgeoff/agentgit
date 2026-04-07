import { authenticatedRoutes } from "@/lib/navigation/routes";

export function normalizeCallbackUrl(value?: string | null): string {
  if (!value) {
    return authenticatedRoutes.dashboard;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return authenticatedRoutes.dashboard;
  }

  return value;
}
