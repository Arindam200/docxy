# The TrueForge harness, with the pieces its local sandbox needs.
#
# Two reasons this file exists rather than pointing a service straight at the
# upstream image.
#
# 1. Railway's "deploy from Docker image" field rejects the upstream tag with
#    "Invalid Docker image". The image is real and anonymously pullable — a
#    plain `docker pull` of it succeeds — so this is Railway's registry probe
#    failing against JFrog, not a bad reference. Building a one-line image from
#    the repository sidesteps that validator entirely: the base is pulled at
#    build time, where it works.
#
# 2. The upstream image cannot run its own sandbox, and says so at startup:
#
#      Local sandbox fallback is unavailable
#      reason: SRT host dependencies missing (linux: bwrap, socat, rg)
#
#    Those four packages are the whole list. With them present the harness
#    reports `Local sandbox fallback is available` and /api/v1/capabilities
#    flips to {"sandbox":{"enabled":true},"skill":{"enabled":true}}.
#
# The sandbox additionally needs the container to be **privileged**. bubblewrap
# mounts /proc inside a new namespace, and unprivileged that fails with
# `bwrap: Can't mount proc on /newroot/proc: Operation not permitted`.
# `--cap-add SYS_ADMIN` alone is not enough; it takes full `--privileged`.
#
# Railway does not offer privileged containers, so on Railway this image gets
# you a working harness but still no local sandbox — use a Daytona provider
# there. On a VM with Docker Compose, `privileged: true` gives you the sandbox
# with no third-party account. guides/DEPLOY.md carries both routes.
FROM tfy.jfrog.io/tfy-images/trueforge:0.1.4-fba492f

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap \
      socat \
      ripgrep \
      python3 \
 && rm -rf /var/lib/apt/lists/*
