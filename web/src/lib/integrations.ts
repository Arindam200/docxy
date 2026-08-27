/**
 * The integrations catalogue.
 *
 * Deliberately a static list rather than something the API reports: these are
 * product integrations — the services a team would connect docxy to — and all
 * but GitHub are still ahead of us. The pipeline's own dependencies (the
 * harness, the model provider, the database) are infrastructure and live on
 * Synced, not here.
 *
 * `status` is the honest bit. Only `live` entries can be connected today;
 * everything else says so on its face rather than offering a button that
 * cannot do anything.
 */

export type IntegrationStatus = "live" | "soon";

export interface CatalogEntry {
  /** Also the key into the brand-icon map. */
  id: string;
  name: string;
  category: string;
  summary: string;
  /** Button label. Rendered disabled unless the entry is live. */
  action: string;
  status: IntegrationStatus;
  /** Where the button goes, for live entries. */
  href?: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    category: "Source",
    summary:
      "Install the App on your repositories and every push opens a documentation pull request, authored by the bot.",
    action: "Install GitHub App",
    status: "live",
  },
  {
    id: "slack",
    name: "Slack",
    category: "Notifications",
    summary:
      "Post to a channel when a run needs approval, and again when the pull request opens.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "discord",
    name: "Discord",
    category: "Notifications",
    summary: "The same run notifications, delivered to a Discord server instead.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "webhooks",
    name: "Webhooks",
    category: "Automation",
    summary:
      "Receive a signed event when a run starts, stalls at approval, or lands — and wire it to anything.",
    action: "Configure",
    status: "soon",
  },
  {
    id: "notion",
    name: "Notion",
    category: "Docs",
    summary: "Publish the pages docxy updates to a Notion workspace as well as the repo.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "linear",
    name: "Linear",
    category: "Issues",
    summary: "Open an issue when documentation drifts, and close it when the PR merges.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "jira",
    name: "Jira",
    category: "Issues",
    summary: "Link each documentation pull request back to the ticket whose change caused it.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "zapier",
    name: "Zapier",
    category: "Automation",
    summary: "Hand run events to a few thousand other apps without writing the glue yourself.",
    action: "Connect",
    status: "soon",
  },
  {
    id: "gitlab",
    name: "GitLab",
    category: "Source",
    summary: "The same push-to-merge-request flow for teams that do not live on GitHub.",
    action: "Notify me",
    status: "soon",
  },
  {
    id: "bitbucket",
    name: "Bitbucket",
    category: "Source",
    summary: "Watch Bitbucket repositories and propose documentation updates the same way.",
    action: "Notify me",
    status: "soon",
  },
  {
    id: "intercom",
    name: "Intercom",
    category: "Support",
    summary: "Turn the support questions your docs fail to answer into drift the pipeline can fix.",
    action: "Configure",
    status: "soon",
  },
];
