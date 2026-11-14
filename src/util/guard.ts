export type Reporter = (text: string) => Promise<void>;

/** Runs a background handler; any failure is logged and posted to #bot-status rather than vanishing. */
export async function guarded(label: string, fn: () => Promise<unknown>, report: Reporter): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${label} failed:`, e);
    try {
      await report(`${label} failed: ${msg}`);
    } catch (reportError) {
      console.error('Could not report failure:', reportError);
    }
  }
}
