import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type RouteCase = {
  deniedPayload: { message: string };
  deniedStatus: number;
  exportName: "GET" | "POST";
  modulePath: string;
  request: Request;
  routeContext?: unknown;
  sessionKind: "role" | "session";
};

const routeCases: RouteCase[] = [
  {
    modulePath: "@/app/api/v1/dashboard/route",
    exportName: "GET",
    request: new Request("http://localhost/api/v1/dashboard"),
    sessionKind: "session",
    deniedStatus: 401,
    deniedPayload: { message: "Unauthorized." },
  },
  {
    modulePath: "@/app/api/v1/approvals/route",
    exportName: "GET",
    request: new Request("http://localhost/api/v1/approvals"),
    sessionKind: "session",
    deniedStatus: 401,
    deniedPayload: { message: "Unauthorized." },
  },
  {
    modulePath: "@/app/api/v1/audit/export/route",
    exportName: "GET",
    request: new Request("http://localhost/api/v1/audit/export?format=csv"),
    sessionKind: "session",
    deniedStatus: 401,
    deniedPayload: { message: "Unauthorized." },
  },
  {
    modulePath: "@/app/api/v1/settings/billing/stripe/portal/route",
    exportName: "POST",
    request: new Request("http://localhost/api/v1/settings/billing/stripe/portal", { method: "POST" }),
    sessionKind: "role",
    deniedStatus: 403,
    deniedPayload: { message: "Forbidden." },
  },
  {
    modulePath: "@/app/api/v1/repos/[repoId]/calibration/route",
    exportName: "GET",
    request: new Request("http://localhost/api/v1/repos/repo_01/calibration"),
    routeContext: { params: Promise.resolve({ repoId: "repo_01" }) },
    sessionKind: "role",
    deniedStatus: 403,
    deniedPayload: { message: "Forbidden." },
  },
  {
    modulePath: "@/app/api/v1/onboarding/route",
    exportName: "GET",
    request: new Request("http://localhost/api/v1/onboarding"),
    sessionKind: "role",
    deniedStatus: 403,
    deniedPayload: { message: "Forbidden." },
  },
];

describe("api auth guard regressions", () => {
  for (const testCase of routeCases) {
    it(`fails closed for ${testCase.modulePath}`, async () => {
      vi.resetModules();

      const requireApiSession = vi.fn();
      const requireApiRole = vi.fn();

      requireApiSession.mockResolvedValue({
        session: null,
        workspaceSession: null,
        unauthorized: Response.json(testCase.deniedPayload, { status: testCase.deniedStatus }),
      });
      requireApiRole.mockResolvedValue({
        session: null,
        workspaceSession: null,
        denied: Response.json(testCase.deniedPayload, { status: testCase.deniedStatus }),
      });

      vi.doMock("@/lib/auth/api-session", () => ({
        requireApiSession,
        requireApiRole,
      }));

      const routeModule = (await import(testCase.modulePath)) as Record<string, (...args: unknown[]) => Promise<Response>>;
      const handler = routeModule[testCase.exportName];
      const response = testCase.routeContext
        ? await handler(testCase.request, testCase.routeContext)
        : await handler(testCase.request);
      const body = await response.json();

      expect(response.status).toBe(testCase.deniedStatus);
      expect(body).toEqual(testCase.deniedPayload);
    });
  }
});
