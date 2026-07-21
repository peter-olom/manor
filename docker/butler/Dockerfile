# syntax=docker/dockerfile:1.7

ARG NODE_BUILD_IMAGE=node:24-trixie
ARG NODE_RUNTIME_IMAGE=node:24-trixie-slim

FROM --platform=$BUILDPLATFORM ${NODE_BUILD_IMAGE} AS build

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
  npm ci

COPY butler/ ./

RUN --mount=type=cache,target=/root/.npm \
  npm run build:web \
  && npm run build:server

FROM ${NODE_BUILD_IMAGE} AS runtime-deps

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN --mount=type=cache,target=/root/.npm \
  npm ci

FROM ${NODE_RUNTIME_IMAGE}

ARG TTYD_VERSION=1.7.7

ENV NODE_ENV=production
WORKDIR /opt/manor/butler

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    fd-find \
    git \
    gh \
    ripgrep \
    util-linux \
    zsh \
    zsh-autosuggestions \
    zsh-syntax-highlighting \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    arm64) ttyd_arch="aarch64" ;; \
    amd64) ttyd_arch="x86_64" ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
  && chmod +x /usr/local/bin/ttyd \
  && groupadd --gid 1001 butler \
  && useradd --uid 1001 --gid butler --create-home --shell /bin/bash butler \
  && mkdir -p /home/butler/.oh-my-zsh/custom /state /repos /artifacts /worker-pi/agent /worker-pi/sessions /harness-state /skills /scratch /butler-executor-runtime /inputs \
  && chown -R butler:butler /home/butler /opt/manor/butler /state /repos /artifacts /worker-pi /harness-state /skills /scratch /butler-executor-runtime /inputs

COPY --chown=butler:butler butler/package.json butler/package-lock.json* ./
COPY --chown=butler:butler --from=runtime-deps /opt/manor/butler/node_modules ./node_modules
COPY --chown=butler:butler --from=build /opt/manor/butler/dist ./dist
COPY --chown=butler:butler butler/index.html ./index.html
COPY --chown=butler:butler butler/public ./public
COPY --chown=butler:butler butler/tsconfig.json ./tsconfig.json
COPY --chown=butler:butler butler/tsconfig.server.json ./tsconfig.server.json
COPY --chown=butler:butler butler/vite.config.ts ./vite.config.ts
COPY docker/butler/start.sh /usr/local/bin/start-butler
COPY docker/butler/auth.sh /usr/local/bin/butler-auth
COPY docker/butler/chatgpt-login.mjs /usr/local/bin/butler-chatgpt-login.mjs
COPY docker/butler/terminal-shell.sh /usr/local/bin/start-butler-shell
COPY docker/butler/worker-pi-rpc-proxy.mjs /usr/local/bin/worker-pi-rpc-proxy.mjs
COPY docker/worker/manor-harness.mjs /usr/local/bin/manor-harness
COPY --chown=butler:butler docker/butler/zshrc /home/butler/.zshrc
COPY --chown=butler:butler docker/butler/zprofile /home/butler/.zprofile

RUN sed -i 's/\r$//' /usr/local/bin/start-butler /usr/local/bin/butler-auth /usr/local/bin/butler-chatgpt-login.mjs /usr/local/bin/start-butler-shell /usr/local/bin/worker-pi-rpc-proxy.mjs /usr/local/bin/manor-harness /home/butler/.zshrc /home/butler/.zprofile \
  && chmod +x /usr/local/bin/start-butler /usr/local/bin/butler-auth /usr/local/bin/butler-chatgpt-login.mjs /usr/local/bin/start-butler-shell /usr/local/bin/worker-pi-rpc-proxy.mjs /usr/local/bin/manor-harness \
  && rm -rf /tmp/* /var/tmp/*

EXPOSE 8080 7682

USER butler

CMD ["/usr/local/bin/start-butler"]
