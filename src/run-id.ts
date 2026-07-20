/** Sortable-ish run id: compact ISO timestamp + random suffix. */
export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}
