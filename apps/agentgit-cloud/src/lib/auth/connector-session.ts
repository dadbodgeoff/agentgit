import { NextResponse } from "next/server";

import {
  ConnectorAccessError,
  getConnectorAccessByToken,
  type ConnectorAccessContext,
} from "@/lib/backend/control-plane/connectors";

export function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function requireConnectorSession(
  request: Request,
):
  | { access: ConnectorAccessContext; denied: null }
  | { access: null; denied: NextResponse } {
  const token = getBearerToken(request);
  if (!token) {
    return {
      access: null,
      denied: NextResponse.json({ message: "Connector authorization is required." }, { status: 401 }),
    };
  }

  try {
    return {
      access: getConnectorAccessByToken(token),
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
