FROM node:22-bookworm

ARG CODEX_VERSION=0.118.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --shell /bin/bash codex \
    && mkdir -p /state /repos /artifacts /home/codex/.codex /opt/manor/codex-box \
    && chown -R codex:codex /state /repos /artifacts /home/codex /opt/manor

COPY docker/codex-box/start.sh /usr/local/bin/start-codex-app-server
COPY docker/codex-box/auth.sh /usr/local/bin/codex-auth
COPY docker/codex-box/healthcheck.mjs /opt/manor/codex-box/healthcheck.mjs

RUN chmod +x /usr/local/bin/start-codex-app-server /usr/local/bin/codex-auth

USER codex
WORKDIR /repos

CMD ["/usr/local/bin/start-codex-app-server"]
