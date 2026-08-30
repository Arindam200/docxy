# syntax=docker/dockerfile:1

# ---- build -------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:22-slim

# git is not a convenience here. The pipeline shells out to it for every diff,
# every throwaway worktree, and every managed checkout, so an image without it
# fails at the first run rather than at build time. ca-certificates is what
# lets that git — and the Nebius and GitHub clients — negotiate TLS at all.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Read from disk at runtime by readSkillPack(), never bundled into dist/. An
# image without this directory starts cleanly and then fails at session
# creation, which is the worst place to discover it.
COPY skills ./skills

# checkoutPathFor() puts managed clones under $HOME/.docxy/checkouts, and both
# the role sessions and the symbol map key on that path. Attach the platform's
# persistent volume here: without one, every redeploy starts the next commit
# from cold sessions and an empty map, which is exactly the accumulation this
# design exists to build.
#
# Deliberately no `VOLUME` instruction. Railway rejects the image for carrying
# one ("docker VOLUME at Line 47 is not supported, use Railway Volumes"), and an
# anonymous volume would in any case shadow the mount a platform attaches here.
ENV HOME=/data
RUN useradd --uid 10001 --home-dir /data --no-create-home --shell /usr/sbin/nologin docxy \
 && mkdir -p /data \
 && chown -R docxy:docxy /data

# Non-root, which is correct anywhere the volume's ownership can be set. Railway
# mounts volumes root-owned and documents the consequence — images running as a
# non-root uid "will have permissions issues when performing operations within
# an attached volume" — so a Railway service needs RAILWAY_RUN_UID=0 alongside
# this. guides/DEPLOY.md carries that in the checklist.
USER docxy

# The platform assigns the real one through PORT; this is the local default.
ENV PORT=4317
EXPOSE 4317

CMD ["node", "dist/server/standalone.js"]
