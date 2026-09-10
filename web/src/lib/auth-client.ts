"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";

/**
 * Browser-side auth. `baseURL` is left unset on purpose so the client talks to
 * the same origin it was served from - which keeps preview deployments and
 * tunnels working without a rebuild.
 *
 * The organization plugin has to be listed here as well as on the server: the
 * client's `organization.*` methods are generated from this list, so omitting
 * it leaves onboarding with no way to create the org it exists to create.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient()],
});

export const { signIn, signUp, signOut, useSession, organization } = authClient;
