import type { MetadataRoute } from "next";

import { publicRoutes } from "@/lib/navigation/routes";
import { resolveMetadataBase } from "@/lib/metadata/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const metadataBase = resolveMetadataBase();
  const publicPages = [publicRoutes.landing, publicRoutes.pricing, publicRoutes.docs, publicRoutes.signIn];

  return publicPages.map((route) => ({
    url: metadataBase ? new URL(route, metadataBase).toString() : route,
    lastModified: new Date(),
    changeFrequency: route === publicRoutes.landing ? "weekly" : "monthly",
    priority: route === publicRoutes.landing ? 1 : route === publicRoutes.pricing ? 0.9 : 0.7,
  }));
}
