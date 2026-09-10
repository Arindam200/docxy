/**
 * Transactional email, through Resend.
 *
 * Three messages, each part of a flow rather than a broadcast: the
 * address-verification link, which is what makes open registration safe to
 * have; the welcome that follows it, which carries somebody into onboarding;
 * and the organization invitation, which is how a one-person org becomes a
 * team. None is marketing, so none has an unsubscribe story.
 *
 * The markup lives in `email-template.ts`, which explains why it is built the
 * way it is. Which mailbox each message leaves from is decided in lib/env.ts,
 * not here: `no-reply@` for the two nobody should answer, `onboarding@` for the
 * welcome, with replies to `support@`.
 *
 * Nothing here is imported at module scope by the auth config - `getEmail()` is
 * called at send time - so a deployment without `RESEND_API_KEY` still boots and
 * still signs existing users in. What it does not do is accept new signups; see
 * `signupOpen()` in lib/env.ts for why those two facts are tied together.
 */

import { Resend } from "resend";
import type { CreateEmailOptions } from "resend";
import {
  appUrl,
  emailFrom,
  onboardingFrom,
  resendConfigured,
  supportAddress,
} from "@/lib/env";
import { site } from "@/lib/site";
import { renderEmail, renderText, type EmailContent } from "@/lib/email-template";

let cached: Resend | undefined;

function getEmail(): Resend {
  // Callers are expected to have checked `resendConfigured()`. This throw is
  // the backstop for the path that forgets, and it names the variable rather
  // than failing inside the SDK with an opaque auth error.
  if (!resendConfigured()) {
    throw new Error(
      "Email is not configured on this deployment: set RESEND_API_KEY and EMAIL_DOMAIN.",
    );
  }
  cached ??= new Resend(process.env.RESEND_API_KEY);
  return cached;
}

/**
 * One send, with the provider's failure surfaced rather than swallowed.
 *
 * Resend reports a rejected send in the response body, not by throwing, so a
 * `catch` alone would let a message that never left be reported as sent. For
 * verification mail that is the difference between "check your inbox" and an
 * account nobody can ever finish creating.
 */
async function send(
  to: string,
  subject: string,
  content: EmailContent,
  /** Overrides for a message that is not from the product itself. */
  sender: { from?: string; replyTo?: string } = {},
): Promise<void> {
  const message: CreateEmailOptions = {
    from: sender.from ?? emailFrom(),
    to,
    subject,
    html: renderEmail(content),
    // Every message carries a text part. One with none is scored as spam by
    // most filters, and these are the messages that cannot afford not to arrive.
    text: renderText(content),
  };
  if (sender.replyTo) message.replyTo = sender.replyTo;

  const { error } = await getEmail().emails.send(message);
  if (error) throw new Error(`Resend refused the message: ${error.message}`);
}

export function verificationContent(url: string): EmailContent {
  return {
    eyebrow: "Confirm your email",
    heading: "Confirm your email address",
    body: [
      "Confirm this address to activate your Docxy account. The link can be used once and expires in one hour.",
      "If you did not create a Docxy account, no action is needed and nothing has been created.",
    ],
    action: { href: url, label: "Confirm email address" },
    links: [{ label: "Documentation", href: site.docs }],
    footer: "You are receiving this message because this address was used to create a Docxy account.",
    preheader: "Confirm your email address to activate your Docxy account.",
  };
}

export function sendVerificationEmail(to: string, url: string): Promise<void> {
  return send(to, "Confirm your email address", verificationContent(url));
}

/** Who signs the welcome. A real person, because it invites a reply. */
const FOUNDER = { name: "Arindam Majumder", role: "Creator of Docxy" } as const;

/**
 * The welcome note, sent once the address is confirmed and not at signup.
 *
 * At signup it would arrive beside the verification mail, addressed to somebody
 * who cannot yet do any of the things it describes, and sent to an address
 * nobody has proved they own. After confirmation it reaches a real person at
 * the moment the next step is actually available to them.
 *
 * It is signed by the founder and sent from an address that accepts replies, so
 * the closing line is an invitation rather than a figure of speech. Which
 * mailbox that is, and where the reply lands, is `sendWelcomeEmail` below.
 */
export function welcomeContent(name: string): EmailContent {
  const first = name.trim().split(/\s+/)[0];
  const app = appUrl() ?? site.url;

  return {
    eyebrow: "Welcome",
    heading: first ? `Welcome to Docxy, ${first}` : "Welcome to Docxy",
    body: [
      "I am Arindam, the creator of Docxy. Thank you for signing up.",
      "Docxy keeps documentation and release notes current as your code changes. It reviews every change pushed to the repositories you connect, drafts the updates each one calls for, and opens a pull request for your team to review. Nothing is published without that review.",
      "Three steps to your first documentation pull request:",
    ],
    steps: [
      `[Create your organization](${app}/onboarding). It holds your repositories, your documentation runs, and anyone you invite.`,
      `[Install the Docxy GitHub App](${site.install}) on the repositories you want documented.`,
      `[Connect a repository](${app}/dashboard/projects/new) and specify the folder its documentation lives in. Documentation kept in a separate repository is supported.`,
    ],
    action: { href: `${app}/onboarding`, label: "Set up your organization" },
    signature: FOUNDER,
    links: [
      { label: "Documentation", href: site.docs },
      { label: "Dashboard", href: `${app}/dashboard` },
    ],
    footer:
      "You are receiving this message because you confirmed your email address on Docxy. Reply to this message and it reaches our support inbox.",
    preheader: "Create your organization and connect your first repository.",
  };
}

/**
 * Sent from `onboarding@` rather than the no-reply, with replies routed to
 * support.
 *
 * The message is signed by a person but it is still generated by the product,
 * and it asks somebody to do three things in a row. Whoever gets stuck on one
 * of them should be able to answer the mail that asked, rather than go looking
 * for an address. The founder's own mailbox is for messages a person actually
 * wrote; see `founderFrom`.
 */
export function sendWelcomeEmail(to: string, name: string): Promise<void> {
  return send(to, "Welcome to Docxy", welcomeContent(name), {
    from: onboardingFrom(),
    replyTo: supportAddress(),
  });
}

export function invitationContent(options: {
  organizationName: string;
  inviterName: string;
  url: string;
}): EmailContent {
  const { organizationName, inviterName, url } = options;
  return {
    eyebrow: "Invitation",
    // `heading`, `footer` and `preheader` are escaped and never linked, so
    // interpolating directly is safe there. `body` is not: see `values`.
    heading: `Join ${organizationName} on Docxy`,
    body: [
      "{inviter} has invited you to join {organization} on Docxy.",
      "Docxy keeps documentation and release notes current as code changes. As a member you will see documentation runs as they happen and review the pull requests Docxy opens for your team.",
      "This invitation expires in seven days.",
    ],
    /*
     * Both of these are typed by whoever created the organization, so they are
     * substituted after the copy has been linked rather than interpolated into
     * it. Written the other way, an organization named
     * `[Verify your account](https://phishing.example)` becomes a live link in
     * a message sent from a verified sending domain.
     */
    values: { inviter: inviterName, organization: organizationName },
    action: { href: url, label: "Accept invitation" },
    links: [{ label: "Documentation", href: site.docs }],
    footer: `You are receiving this message because ${inviterName} invited this address to ${organizationName} on Docxy.`,
    preheader: `${inviterName} invited you to join ${organizationName} on Docxy.`,
  };
}

export function sendInvitationEmail(options: {
  to: string;
  organizationName: string;
  inviterName: string;
  url: string;
}): Promise<void> {
  const { to, organizationName, inviterName } = options;
  return send(
    to,
    `${inviterName} invited you to join ${organizationName} on Docxy`,
    invitationContent(options),
  );
}
