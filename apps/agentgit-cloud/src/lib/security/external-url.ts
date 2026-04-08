export function sanitizeExternalUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function isTrustedStripeHostedUrl(value: string | null | undefined): boolean {
  const sanitized = sanitizeExternalUrl(value);
  if (!sanitized) {
    return false;
  }

  const hostname = new URL(sanitized).hostname.toLowerCase();
  return hostname === "checkout.stripe.com" || hostname === "billing.stripe.com";
}
