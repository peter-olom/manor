# syntax=docker/dockerfile:1.7

ARG NODE_BUILD_IMAGE=node:24-trixie
ARG NODE_RUNTIME_IMAGE=node:24-trixie-slim

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS worker-build

WORKDIR /opt/manor/worker

COPY butler/package.json butler/package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY butler/ ./

RUN --mount=type=cache,target=/root/.npm \
    npm run build:server

FROM ${NODE_BUILD_IMAGE} AS worker-runtime-deps

WORKDIR /opt/manor/worker

COPY butler/package.json butler/package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM ${NODE_RUNTIME_IMAGE} AS tools

ARG MISE_VERSION=2026.4.3
ARG TTYD_VERSION=1.7.7

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      git \
    && rm -rf /var/lib/apt/lists/* \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
      arm64) ttyd_arch="aarch64" ;; \
      amd64) ttyd_arch="x86_64" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && npm install --global --prefix /opt/manor/npm-global "@jdxcode/mise@${MISE_VERSION}" \
    && npm cache clean --force \
    && git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /opt/manor/ohmyzsh

FROM ${NODE_RUNTIME_IMAGE}

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      bubblewrap \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      git \
      gh \
      jq \
      python-is-python3 \
      python3 \
      python3-pip \
      python3-venv \
      ripgrep \
      unzip \
      xz-utils \
      zsh \
      zsh-autosuggestions \
      zsh-syntax-highlighting \
      zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 worker \
    && useradd --uid 1001 --gid worker --create-home --shell /bin/bash worker \
    && mkdir -p /state /repos /artifacts /worker-pi/agent /worker-pi/sessions /worker-runtime /home/worker/.config/gh /home/worker/.config/manor /opt/manor/worker \
    && mkdir -p /home/worker/.oh-my-zsh/custom \
    && chown -R worker:worker /state /repos /artifacts /worker-pi /worker-runtime /home/worker /opt/manor

COPY --from=tools /usr/local/bin/ttyd /usr/local/bin/ttyd
COPY --from=tools /opt/manor/npm-global /opt/manor/npm-global
COPY --chown=worker:worker --from=tools /opt/manor/ohmyzsh /home/worker/.oh-my-zsh
COPY --from=worker-runtime-deps /opt/manor/worker/node_modules /opt/manor/worker/node_modules
COPY --from=worker-build /opt/manor/worker/dist/server /opt/manor/worker/dist/server
COPY docker/worker/start.sh /usr/local/bin/start-worker
COPY docker/worker/gh-auth-headless.sh /usr/local/bin/gh-auth-headless
COPY docker/worker/gh-headless-browser.sh /usr/local/bin/gh-headless-browser
COPY docker/worker/bootstrap-tools.sh /usr/local/bin/worker-bootstrap-tools
COPY docker/worker/ownership-init.sh /usr/local/bin/manor-ownership-init
COPY docker/worker/manor-harness.mjs /usr/local/bin/manor-harness
COPY docker/worker/git-admission.sh /usr/local/bin/git
COPY docker/worker/healthcheck.mjs /opt/manor/worker/healthcheck.mjs
COPY docker/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/worker-pi-rpc-bridge.mjs
COPY docker/worker/butler-executor.mjs /opt/manor/worker/butler-executor.mjs
COPY --chown=worker:worker docker/worker/zshrc /home/worker/.zshrc
COPY --chown=worker:worker docker/worker/zprofile /home/worker/.zprofile

RUN mkdir -p /home/worker/.local/bin /home/worker/.local/share/mise \
    && chown -R worker:worker /home/worker/.local

ENV MANOR_REAL_PATH="/home/worker/.local/bin:/home/worker/.local/share/mise/shims:/home/worker/.local/share/mise/bin:/opt/manor/npm-global/bin:${PATH}"
ENV PATH="${MANOR_REAL_PATH}"
ENV WORKER_PI_CLI_PATH="/opt/manor/worker/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
ENV WORKER_PI_RPC_SOCKET="/worker-runtime/pi-rpc.sock"

RUN mkdir -p /scratch /butler-executor-runtime \
    && chown worker:worker /scratch /butler-executor-runtime \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && sed -i 's/\r$//' /usr/local/bin/start-worker /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/worker-bootstrap-tools /usr/local/bin/manor-harness /usr/local/bin/git /opt/manor/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/butler-executor.mjs /home/worker/.zshrc /home/worker/.zprofile \
    && chmod 755 /usr/local/bin/start-worker /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/worker-bootstrap-tools /usr/local/bin/manor-ownership-init /usr/local/bin/manor-harness /usr/local/bin/git /opt/manor/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/butler-executor.mjs \
    && chown -R worker:worker /home/worker/.oh-my-zsh /home/worker/.zshrc /home/worker/.zprofile \
    && rm -rf /tmp/* /var/tmp/*

USER worker
WORKDIR /repos

CMD ["/usr/local/bin/start-worker"]
