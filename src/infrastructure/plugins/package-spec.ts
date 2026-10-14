const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const IDENTIFIER = '(?:0|[1-9]\\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const EXACT_VERSION = new RegExp(`^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** Parses the exact public registry spec accepted by both CLI and npm staging. */
export function parsePluginSpec(spec: string): { name: string; version: string } {
  const separator = spec.lastIndexOf('@');
  if (separator <= 0 || separator === spec.length - 1) throw new Error('Plugin spec must be an exact package@version, for example @scope/package@1.2.3.');
  const name = spec.slice(0, separator);
  const version = spec.slice(separator + 1);
  if (!PACKAGE_NAME.test(name) || name.includes('..')) throw new Error('Plugin package name is invalid.');
  if (!EXACT_VERSION.test(version)) throw new Error('Plugin version must be an exact semantic version.');
  return { name, version };
}
