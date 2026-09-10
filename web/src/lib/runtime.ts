/**
 * Whether this is somebody's laptop rather than a deployment.
 *
 * Copy that tells an operator to run `npm run serve` is help on a development
 * machine and noise on a deployed dashboard, where there is no terminal, no
 * checkout, and nobody who can act on it - the fix there is a service that is
 * down or a variable that is wrong. The same screens serve both, so the remedy
 * has to be chosen at render time rather than written once and hoped over.
 *
 * `NODE_ENV` is the signal because it is the one variable Next inlines into the
 * client bundle as well as the server, so a client component can ask this
 * question too. `next dev` sets it to `development`; every build - Vercel's or
 * `next build` locally - sets it to `production`.
 */
export const localDev = process.env.NODE_ENV !== "production";
