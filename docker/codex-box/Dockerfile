FROM node:22-bookworm

ARG CODEX_VERSION=0.118.0
ARG MISE_VERSION=2026.4.3

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bubblewrap \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      git \
      jq \
      python-is-python3 \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      unzip \
      xz-utils \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@jdxcode/mise@${MISE_VERSION}" \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --create-home --shell /bin/bash codex \
    && mkdir -p /state /repos /artifacts /home/codex/.codex /opt/manor/codex-box \
    && chown -R codex:codex /state /repos /artifacts /home/codex /opt/manor

COPY docker/codex-box/start.sh /usr/local/bin/start-codex-app-server
COPY docker/codex-box/auth.sh /usr/local/bin/codex-auth
COPY docker/codex-box/bootstrap-tools.sh /usr/local/bin/codex-bootstrap-tools
COPY docker/codex-box/healthcheck.mjs /opt/manor/codex-box/healthcheck.mjs

ENV PATH="/home/codex/.local/bin:/home/codex/.local/share/mise/shims:/home/codex/.local/share/mise/bin:${PATH}"

RUN chmod +x /usr/local/bin/start-codex-app-server /usr/local/bin/codex-auth /usr/local/bin/codex-bootstrap-tools

USER codex
WORKDIR /repos

CMD ["/usr/local/bin/start-codex-app-server"]
