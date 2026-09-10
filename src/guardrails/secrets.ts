import type { RegexRule } from '@mastra/core/processors';

/**
 * Credential shapes that must never reach a model provider.
 *
 * Mastra's own `secrets` preset covers three patterns - an `api_key =` style
 * assignment, a `Bearer` header, and an AWS access key id. That is a reasonable
 * default for a chat application and nowhere near enough here, because the
 * untrusted text this pipeline reads is a *commit diff*: the one document whose
 * whole purpose is to show lines someone just added, including the line where
 * they added a key by mistake. A probe with a Stripe secret key and a GitHub
 * personal access token passed the preset untouched and reached the model.
 *
 * Every rule below is anchored on a vendor's own documented prefix rather than
 * on entropy. That direction of error is deliberate: a pattern that fires on
 * anything long and random would redact identifiers, hashes and minified code
 * out of ordinary diffs, and a guard that mangles normal work is one an
 * operator turns off. These match things that are only ever credentials.
 *
 * Sources are each vendor's published token format. When a vendor adds a
 * prefix, this list is where it goes.
 */
export const SECRET_RULES: RegexRule[] = [
  // --- Cloud providers -----------------------------------------------------
  {
    name: 'aws-access-key-id',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED aws-access-key-id]',
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: '[REDACTED google-api-key]',
  },

  // --- Source hosting ------------------------------------------------------
  //
  // The one this repository would leak first: docxy holds a GitHub App
  // installation token to open its own pull requests.
  {
    name: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g,
    replacement: '[REDACTED github-token]',
  },
  {
    name: 'gitlab-token',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED gitlab-token]',
  },

  // --- Payments ------------------------------------------------------------
  {
    name: 'stripe-key',
    pattern: /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED stripe-key]',
  },

  // --- Model providers -----------------------------------------------------
  //
  // Including the ones this pipeline itself uses. A diff that leaks the Nebius
  // key would otherwise be sent to Nebius.
  // Anthropic before OpenAI: `sk-ant-…` matches both, and whichever runs first
  // is the name that ends up in the audit line.
  {
    name: 'anthropic-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED anthropic-key]',
  },
  {
    name: 'openai-key',
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED openai-key]',
  },
  {
    name: 'huggingface-token',
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    replacement: '[REDACTED huggingface-token]',
  },

  // --- Messaging and CI ----------------------------------------------------
  {
    name: 'slack-token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: '[REDACTED slack-token]',
  },
  {
    name: 'slack-webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+]+/g,
    replacement: '[REDACTED slack-webhook]',
  },
  {
    name: 'npm-token',
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: '[REDACTED npm-token]',
  },

  // --- Key material --------------------------------------------------------
  //
  // Matched from the armour rather than the body, so the whole block goes
  // rather than the first line of it.
  {
    name: 'private-key-block',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: '[REDACTED private-key-block]',
  },

  // --- Connection strings --------------------------------------------------
  //
  // The password inside a URL, and only the password: the host and database
  // name are often exactly what a documentation change is about.
  {
    name: 'url-password',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s/@]+@/gi,
    replacement: '$1:[REDACTED]@',
  },

  // --- Generic assignments -------------------------------------------------
  //
  // Last, and deliberately narrow. It wants a credential-shaped *name*, a
  // quoted value, and twenty characters of it - so `password: hunter2` and
  // `token = process.env.X` both pass through, while a pasted literal does not.
  {
    name: 'assigned-credential',
    pattern:
      /\b(?:secret|token|passwd|password|passphrase|credential|private[_-]?key)[a-z0-9_-]*\s*[:=]\s*["'`][^"'`\s]{20,}["'`]/gi,
    replacement: '[REDACTED assigned-credential]',
  },
];

/** What a redaction pass removed, and what is left to send. */
export interface Redaction {
  text: string;
  /** Names of the rules that fired, for the audit line. Never the values. */
  redacted: string[];
}

/**
 * Redact every known credential shape in a string.
 *
 * Exported for the tests and for anywhere text reaches a model outside an
 * agent call. The processor on the agents is the one that runs in production -
 * this is the same rules, applied directly.
 */
export function redactSecrets(text: string): Redaction {
  const redacted: string[] = [];
  let out = text;
  for (const rule of SECRET_RULES) {
    // `lastIndex` persists on a global regex between calls, so a fresh one is
    // used rather than the shared rule object, which would otherwise start
    // scanning from wherever the previous string left off.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (!pattern.test(out)) continue;
    redacted.push(rule.name);
    out = out.replace(
      new RegExp(rule.pattern.source, rule.pattern.flags),
      rule.replacement ?? '[REDACTED]',
    );
  }
  return { text: out, redacted };
}
