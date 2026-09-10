import { ToastNotice } from "./Toast";

import { lookup } from "@/lib/lookup";

/**
 * What the GitHub install round trip has to say when it comes back.
 *
 * The install routes can only communicate by redirecting with a query
 * parameter, so without this the refusals are silent: somebody installs the
 * App, is bounced to a dashboard with no repositories in it, and has nothing to
 * read. Two of these are security refusals and one of those is not the
 * installer's fault, so each gets a sentence saying what to do next rather than
 * a code.
 */

const MESSAGES = {
  install_forbidden: {
    tone: "danger",
    text: "GitHub did not confirm that your account administers that installation, so it was not connected. Install the App from the account that owns the repositories.",
  },
  install_owned: {
    tone: "danger",
    text: "That installation already belongs to another organization here. Whoever owns it has to disconnect it before it can be moved.",
  },
  install_expired: {
    tone: "danger",
    text: "This connection attempt expired or your active organization changed. Start again from Connect GitHub in Repositories.",
  },
  install_cancelled: {
    tone: "danger",
    text: "GitHub authorization was cancelled. Use Connect GitHub in Repositories when you are ready to try again.",
  },
  install_unverifiable: {
    tone: "danger",
    text: "GitHub connections are not ready on this deployment. Contact support to finish setup; reinstalling the App will not resolve this.",
  },
  install_not_bound: {
    tone: "danger",
    text: "The App is installed on GitHub, but recording it here failed. Reload in a moment, or reinstall to try again.",
  },
  no_installation: {
    tone: "danger",
    text: "GitHub returned without an installation id, so there was nothing to connect.",
  },
  app_unconfigured: {
    tone: "danger",
    text: "No GitHub App is configured on this deployment, so there is nothing to install.",
  },
} satisfies Record<string, { tone: "danger"; text: string }>;

const OUTCOMES = {
  // Installing is access, not intent. Telling somebody a push will now start a
  // run would be describing the behaviour this deployment deliberately does not
  // have: nothing is watched until a repository is connected as a project, and
  // this notice renders on the page that connects one.
  installed:
    "The GitHub App is installed. Connect a repository below to start watching it - a push only starts a run once a project connects it.",
  requested:
    "Your install request was sent to an owner of that GitHub account. It connects once they approve it.",
} satisfies Record<string, string>;

export function GithubNotice({ error, github }: { error?: string; github?: string }) {
  const failure = error ? lookup(MESSAGES, error) : undefined;
  const outcome = github ? lookup(OUTCOMES, github) : undefined;

  return <ToastNotice message={failure?.text ?? outcome} tone={failure ? "error" : github === "requested" ? "info" : "success"} parameters={["error", "github"]} />;
}
