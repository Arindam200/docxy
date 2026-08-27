"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth. `baseURL` is left unset on purpose so the client talks to
 * the same origin it was served from — which keeps preview deployments and
 * tunnels working without a rebuild.
 */
export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
