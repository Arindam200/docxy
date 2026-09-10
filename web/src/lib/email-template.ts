/**
 * The mail template, built to match the dashboard rather than a mail library's
 * idea of a nice email.
 *
 * Three things drive every decision here, and none of them apply to the app:
 *
 * 1. **Tables, not flexbox.** Outlook renders through Word, which has no
 *    support for modern layout at all. A `<div>` column that looks right in
 *    Gmail collapses to full-bleed there.
 * 2. **Inline styles.** Gmail strips `<style>` blocks in several contexts,
 *    notably the mobile clients, so anything load-bearing is on the element.
 *    The one `<style>` block below carries only the dark-mode overrides, which
 *    are a nicety and may be dropped without harm.
 * 3. **No images.** Most clients block remote images by default, so a logo
 *    would be a broken box on first read. The wordmark is set in type, exactly
 *    as `Wordmark` sets it in the app.
 *
 * The palette is `globals.css`, copied deliberately: an email cannot read CSS
 * custom properties, and a token that silently resolved to nothing would render
 * black-on-black. Keep these in step by hand if the theme moves.
 */

const COLOR = {
  background: "#ffffff",
  foreground: "#18181b",
  accent: "#2179fc",
  accentDeep: "#0357d3",
  rule: "#c4c4cc",
  surface: "#f7f7f8",
  muted: "#52525b",
} as const;

/** Geist first for the few clients that resolve it, then the usual stack. */
const SANS =
  "Geist, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export interface EmailContent {
  /** The small mono line above the heading, as on the auth screens. */
  eyebrow: string;
  heading: string;
  /** One or two short paragraphs. Plain text; no markup expected. */
  body: string[];
  action: { href: string; label: string };
  /**
   * What to do next, rendered as a numbered panel under the copy.
   *
   * Numbered because these really are a sequence: an organization exists before
   * a repository can be connected to it. Prose describing three ordered steps
   * is a paragraph somebody skims; three numbered lines are three things
   * somebody does.
   */
  steps?: string[];
  /** Links along the bottom, for the things worth reading that are not the action. */
  links?: Array<{ label: string; href: string }>;
  /**
   * Untrusted text, substituted into `{name}` placeholders in `body` and
   * `steps` after links have been resolved.
   *
   * Anything a person typed belongs here rather than interpolated into the copy
   * directly: an organization name, a display name, a repository. See `linkify`
   * for what happens when it goes in the other way.
   */
  values?: Record<string, string>;
  /** The grey line at the bottom explaining why this arrived. */
  footer: string;
  /**
   * Inbox preview text.
   *
   * Without it, clients pull the first words of the body - which here is the
   * eyebrow, so every message would preview as "DOCXY". Hidden in the render.
   */
  preheader: string;
  /**
   * Signs the message off as a person rather than as the product.
   *
   * Only the welcome uses it. A note that says "reply and tell me" has to come
   * from somebody who can actually read the reply, so this travels with a real
   * From and Reply-To - see `sendWelcomeEmail`. A signature on a `noreply`
   * address would be a small lie in the first message somebody gets.
   */
  signature?: { name: string; role: string };
}

/** Ampersands and angle brackets, so a name or repository cannot break the markup. */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turns `[label](https://...)` in copy into a styled anchor.
 *
 * **This runs over template prose only, never over a value somebody typed.**
 * Escaping stops markup, but it does not stop this pattern: `[` and `(` are not
 * characters `escape` touches, so an organization named
 * `[Verify your account](https://phishing.example)` would have become a live
 * link inside a message sent from a verified sending domain, which is a better
 * phishing primitive than most attackers get to build for themselves. Untrusted
 * values go in through `values` below, which substitutes them *after* this has
 * run and therefore cannot produce a link.
 *
 * The scheme allowlist is the second lock: a target that is not `https:` or
 * `mailto:` renders as its label in plain text rather than as an anchor.
 * Nothing in this product's copy needs another scheme, and `javascript:` in an
 * HTML part is inert in mail clients but not in a browser previewing it.
 */
function linkify(value: string): string {
  return escape(value).replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    // The href arrives already escaped, so `&` is `&amp;` - harmless in an
    // attribute, and the scheme is at the front where this reads it.
    if (!/^(https:|mailto:)/i.test(href.trim())) return label;
    return `<a href="${href}" style="color:${COLOR.accentDeep};text-decoration:underline;text-underline-offset:2px">${label}</a>`;
  });
}

/**
 * Fill `{name}` placeholders with text nobody on this side wrote.
 *
 * Substitution happens after `linkify`, which is the whole point: by then the
 * link pattern has already been applied, so a value carrying `[...](...)`
 * arrives as the characters somebody typed rather than as an anchor.
 */
function fill(text: string, values: Record<string, string> | undefined): string {
  const linked = linkify(text);
  if (!values) return linked;

  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, escape(value)),
    linked,
  );
}

export function renderEmail(content: EmailContent): string {
  const { eyebrow, heading, body, action, footer, preheader, signature, steps, links, values } =
    content;

  const signoff = signature
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
         <tr>
           <td class="docxy-heading" style="font-size:15px;font-weight:500;line-height:1.5;color:${COLOR.foreground}">
             ${escape(signature.name)}<br>
             <span class="docxy-text" style="font-size:13px;font-weight:400;color:${COLOR.muted}">${escape(signature.role)}</span>
           </td>
         </tr>
       </table>`
    : "";

  const paragraphs = body
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${COLOR.muted}">${fill(text, values)}</p>`,
    )
    .join("");

  const stepList = steps?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="docxy-panel" style="margin:4px 0 0;background:${COLOR.surface};border:1px solid ${COLOR.rule}">
         <tr><td style="padding:18px 20px">
           ${steps
             .map(
               (step, index) =>
                 `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"${
                   index === steps.length - 1 ? "" : ' style="margin-bottom:12px"'
                 }>
                    <tr>
                      <td valign="top" width="26" style="font-family:${MONO};font-size:12px;line-height:1.6;color:${COLOR.accent};padding-right:6px">${String(index + 1).padStart(2, "0")}</td>
                      <td class="docxy-text" style="font-size:14px;line-height:1.6;color:${COLOR.muted}">${fill(step, values)}</td>
                    </tr>
                  </table>`,
             )
             .join("")}
         </td></tr>
       </table>`
    : "";

  const linkRow = links?.length
    ? `<p class="docxy-fallback" style="margin:16px 0 0;font-size:13px;line-height:1.7;color:${COLOR.muted}">
         ${links
           .map(
             (link) =>
               `<a href="${escape(link.href)}" style="color:${COLOR.accentDeep};text-decoration:none;font-weight:500">${escape(link.label)}</a>`,
           )
           .join(`<span style="color:${COLOR.rule}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`)}
       </p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escape(heading)}</title>
<style>
  /* Honoured by Apple Mail and a few others; ignored elsewhere, which is why
     nothing structural lives in here. Mirrors the dashboard's dark palette. */
  @media (prefers-color-scheme: dark) {
    .docxy-body { background:#09090b !important; }
    .docxy-card { background:#101013 !important; border-color:#232329 !important; }
    .docxy-heading, .docxy-mark { color:#fafafa !important; }
    .docxy-text, .docxy-footer, .docxy-fallback { color:#9d9da8 !important; }
    .docxy-rule { border-color:#232329 !important; }
    .docxy-panel { background:#161619 !important; border-color:#232329 !important; }
    a[href] { color:#5c9dff !important; }
  }
</style>
</head>
<body class="docxy-body" style="margin:0;padding:0;background:${COLOR.surface};font-family:${SANS};-webkit-font-smoothing:antialiased">

<!-- Inbox preview, then enough zero-width space to stop the client filling the
     rest of the line with the markup that follows it. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0">
  ${escape(preheader)}
  ${"&#847;&zwnj;&nbsp;".repeat(60)}
</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${COLOR.surface}">
  <tr>
    <td align="center" style="padding:40px 16px">

      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px">

        <!-- Wordmark, set in type for the same reason there is no logo image. -->
        <tr>
          <td style="padding:0 0 20px">
            <span class="docxy-mark" style="font-family:${SANS};font-size:19px;font-weight:600;letter-spacing:-0.02em;color:${COLOR.foreground}">docxy</span>
          </td>
        </tr>

        <!-- One card, one rule, one accent. -->
        <tr>
          <td class="docxy-card" style="background:${COLOR.background};border:1px solid ${COLOR.rule};padding:36px 32px">

            <p style="margin:0 0 14px;font-family:${MONO};font-size:11px;text-transform:uppercase;letter-spacing:0.22em;color:${COLOR.muted}">
              <span style="color:${COLOR.accent}">&rsaquo;</span> ${escape(eyebrow)}
            </p>

            <h1 class="docxy-heading" style="margin:0 0 16px;font-size:24px;line-height:1.25;font-weight:600;letter-spacing:-0.02em;color:${COLOR.foreground}">${escape(heading)}</h1>

            <div class="docxy-text">${paragraphs}</div>
            ${stepList}
            ${signoff}

            <!-- Bulletproof button: the table is what gives Outlook a box to
                 paint, since it ignores padding on an anchor. -->
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
              <tr>
                <td style="background:${COLOR.accentDeep}">
                  <a href="${escape(action.href)}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:14px;font-weight:500;line-height:1;color:#ffffff;text-decoration:none">${escape(action.label)}</a>
                </td>
              </tr>
            </table>

            <hr class="docxy-rule" style="margin:28px 0 16px;border:0;border-top:1px solid ${COLOR.rule}">

            <p class="docxy-fallback" style="margin:0;font-size:12px;line-height:1.6;color:${COLOR.muted}">
              Or paste this into your browser:<br>
              <span style="font-family:${MONO};font-size:11px;word-break:break-all">${escape(action.href)}</span>
            </p>
            ${linkRow}

          </td>
        </tr>

        <tr>
          <td class="docxy-footer" style="padding:20px 4px 0;font-size:12px;line-height:1.6;color:${COLOR.muted}">
            ${escape(footer)}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/**
 * The same message as plain text.
 *
 * Not a courtesy: a message with no text part is scored as spam by most
 * filters, and the one thing these emails cannot afford is to not arrive.
 */
export function renderText(content: EmailContent): string {
  const signoff = content.signature
    ? ["", content.signature.name, content.signature.role]
    : [];

  /*
   * The same substitution as the HTML part, without the escaping.
   *
   * There is no markup here to break out of, and no anchor for a `[...](...)`
   * in somebody's organization name to become: in plain text those characters
   * are the characters they are.
   */
  const plain = (text: string): string =>
    Object.entries(content.values ?? {}).reduce(
      (result, [key, value]) => result.replaceAll(`{${key}}`, value),
      text,
    );

  // `[label](url)` reads perfectly well as plain text, so the markers stay:
  // stripping them would drop the URL, and rewriting them would lose the label.
  const stepLines = content.steps?.length
    ? ["", ...content.steps.map((step, index) => `${index + 1}. ${plain(step)}`)]
    : [];

  const linkLines = content.links?.length
    ? ["", ...content.links.map((link) => `${link.label}: ${link.href}`)]
    : [];

  return [
    `docxy / ${content.heading}`,
    "",
    ...content.body.map(plain),
    ...stepLines,
    ...signoff,
    "",
    `${content.action.label}: ${content.action.href}`,
    ...linkLines,
    "",
    content.footer,
  ].join("\n");
}
