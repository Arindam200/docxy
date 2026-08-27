import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

/**
 * Every Better Auth endpoint — sign-in, sign-up, OAuth callbacks, sign-out —
 * hangs off this one catch-all. The handler is passed as a closure rather than
 * as `auth.handler` so the auth instance is built on first request instead of
 * at module load; see lib/auth.ts.
 */
export const { GET, POST } = toNextJsHandler((request) => getAuth().handler(request));
