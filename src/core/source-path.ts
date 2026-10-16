/**
 * Validates a portable workspace-relative source path. `/` is the only accepted
 * separator so callers cannot accidentally reinterpret a backslash differently
 * on POSIX and Windows. Unicode and case are preserved as supplied.
 */
export function normalizeRelativeSourcePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new Error('Source paths must be non-empty relative paths using `/` separators.');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    throw new Error('Source paths cannot be absolute paths or URI schemes.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Source paths cannot contain empty, `.` or `..` segments.');
  }
  return segments.join('/');
}
