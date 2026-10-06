// The {{placeholder}} contract between media/*.html and physSimPanel.ts, as a
// pure, vscode-free module so test/webviewHtml.test.mjs can check the
// templates against it in Node.

/** Placeholders buildHtml() fills on every page. */
export const COMMON_PLACEHOLDERS = ["csp", "nonce", "panelCss"] as const;

/** Each page's own placeholders. The values are typed from this, so a key
 *  added here without a value in physSimPanel.ts fails to compile. */
export const PAGE_PLACEHOLDERS = {
  "panel.html": ["threeUri", "orbitUri", "tcUri", "panelJs", "piMax", "piTenthMax", "timeScale"],
  "monitors.html": ["monitorsJs"]
} as const;

export type Page = keyof typeof PAGE_PLACEHOLDERS;
export type PageValues<P extends Page> = Record<(typeof PAGE_PLACEHOLDERS)[P][number], string>;

/**
 * Replace every {{key}} token in the template. Throws if any token remains
 * unresolved — catches placeholder typos at panel-open time instead of
 * silently shipping broken markup.
 */
export function substituteTemplate(template: string, values: Record<string, string>, page: string): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  const leftover = /\{\{\w+\}\}/.exec(out);
  if (leftover) {
    throw new Error(`PhySim: unresolved placeholder ${leftover[0]} in media/${page}`);
  }
  return out;
}
