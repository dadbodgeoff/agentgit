import { NextResponse } from "next/server";

import {
  ConnectorAccessError,
  getConnectorAccessByToken,
  type ConnectorAccessContext,
} from "@/lib/backend/control-plane/connectors";
import { enforceConnectorRateLimits } from "@/lib/security/rate-limit";

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export async function requireConnectorSession(
  request: Request,
):
  Promise<
    | { access: ConnectorAccessContext; denied: null }
    | { access: null; denied: NextResponse }
  > {
  const token = getBearerToken(request);
  if (!token) {
    return {
      access: null,
      denied: NextResponse.json({ message: "Connector authorization is required." }, { status: 401 }),
    };
  }

  try {
    const access = getConnectorAccessByToken(token);
    const rateLimited = await enforceConnectorRateLimits(request, access.connector.workspaceId);
    if (rateLimited) {
      return {
        access: null,
        denied: rateLimited,
      };
    }

    return {
      access,
      denied: null,
    };
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return {
        access: null,
        denied: NextResponse.json({ message: error.message }, { status: error.statusCode }),
      };
    }

    return {
      access: null,
      denied: NextResponse.json({ message: "Connector authorization failed." }, { status: 401 }),
    };
  }
}
