export function filterManifestToCompatibilitySurface(manifest, compatibilityPackageNames) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.packages)) {
    throw new Error("CLI compatibility manifest is missing a packages array.");
  }

  const filteredPackages = manifest.packages.filter((pkg) => compatibilityPackageNames.has(pkg.name));
  const missingPackages = [...compatibilityPackageNames].filter(
    (packageName) => !filteredPackages.some((pkg) => pkg.name === packageName),
  );

  if (missingPackages.length > 0) {
    throw new Error(`CLI compatibility manifest is missing required packages: ${missingPackages.join(", ")}`);
  }

  return {
    ...manifest,
    packages: filteredPackages,
  };
}
