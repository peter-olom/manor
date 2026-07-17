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
    && useradd --create-home --shell /bin/bash worker \
    && mkdir -p /state /repos /artifacts /worker-pi/agent /worker-pi/sessions /worker-runtime /home/worker/.config/gh /home/worker/.config/manor /opt/manor/worker /opt/manor/worker \
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
COPY docker/worker/manor-harness.mjs /usr/local/bin/manor-harness
COPY docker/worker/install-guard.sh /opt/manor/worker/install-guard.sh
COPY docker/worker/python-guard.sh /opt/manor/worker/python-guard.sh
COPY docker/worker/runtime-guard.sh /opt/manor/worker/runtime-guard.sh
COPY docker/worker/manor-shell-env.sh /etc/profile.d/manor-shell-env.sh
COPY docker/worker/healthcheck.mjs /opt/manor/worker/healthcheck.mjs
COPY docker/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/worker-pi-rpc-bridge.mjs
COPY --chown=worker:worker docker/worker/zshrc /home/worker/.zshrc
COPY --chown=worker:worker docker/worker/zprofile /home/worker/.zprofile

RUN mkdir -p /home/worker/.local/bin /home/worker/.local/share/mise \
    && chown -R worker:worker /home/worker/.local

ENV MANOR_REAL_PATH="/home/worker/.local/bin:/home/worker/.local/share/mise/shims:/home/worker/.local/share/mise/bin:/opt/manor/npm-global/bin:${PATH}"
ENV PATH="/opt/manor/worker/install-guard-bin:${MANOR_REAL_PATH}"
ENV WORKER_PI_CLI_PATH="/opt/manor/worker/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
ENV WORKER_PI_RPC_SOCKET="/worker-runtime/pi-rpc.sock"

RUN mkdir -p /opt/manor/worker/install-guard-bin \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/npm \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/npx \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/pnpm \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/pnpx \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/yarn \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/yarnpkg \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/bun \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/bunx \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/pip \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/pip3 \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/pipx \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/uv \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/uvx \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/poetry \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/gem \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/bundle \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/composer \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/cargo \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/go \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/corepack \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/playwright \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/apt \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/apt-get \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/apk \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/dnf \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/yum \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/brew \
    && ln -sf /opt/manor/worker/install-guard.sh /opt/manor/worker/install-guard-bin/mise \
    && for command in make cmake ctest meson ninja gradle mvn ant pytest rspec tsx ts-node jest vitest; do ln -sf /opt/manor/worker/install-guard.sh "/opt/manor/worker/install-guard-bin/${command}"; done \
    && ln -sf /opt/manor/worker/python-guard.sh /opt/manor/worker/install-guard-bin/python \
    && ln -sf /opt/manor/worker/python-guard.sh /opt/manor/worker/install-guard-bin/python3 \
    && for command in node deno ruby php java javac dotnet swift kotlin kotlinc lua perl R Rscript gcc g++ clang clang++; do ln -sf /opt/manor/worker/runtime-guard.sh "/opt/manor/worker/install-guard-bin/${command}"; done \
    && sed -i 's/\r$//' /usr/local/bin/start-worker /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/worker-bootstrap-tools /usr/local/bin/manor-harness /opt/manor/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/install-guard.sh /opt/manor/worker/python-guard.sh /opt/manor/worker/runtime-guard.sh /etc/profile.d/manor-shell-env.sh /home/worker/.zshrc /home/worker/.zprofile \
    && chmod 755 /usr/local/bin/start-worker /usr/local/bin/gh-auth-headless /usr/local/bin/gh-headless-browser /usr/local/bin/worker-bootstrap-tools /usr/local/bin/manor-harness /opt/manor/worker/worker-pi-rpc-bridge.mjs /opt/manor/worker/install-guard.sh /opt/manor/worker/python-guard.sh /opt/manor/worker/runtime-guard.sh /etc/profile.d/manor-shell-env.sh \
    && chown -R worker:worker /home/worker/.oh-my-zsh /home/worker/.zshrc /home/worker/.zprofile \
    && rm -rf /tmp/* /var/tmp/*

USER worker
WORKDIR /repos

CMD ["/usr/local/bin/start-worker"]
