/** Converts Date | null | undefined to epoch ms (or null). */
export const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
/** Converts epoch ms to ISO string (or null). */
export const iso = (n: number | null | undefined): string | null => (n == null || !Number.isFinite(n) ? null : new Date(n).toISOString());
export const isValidTimezone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
