ARG NODE_BUILD_IMAGE=node:24-trixie
ARG NODE_RUNTIME_IMAGE=node:24-trixie-slim

FROM ${NODE_BUILD_IMAGE} AS build

ARG PI_VERSION=0.73.0

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN npm ci \
  && npm install "@mariozechner/pi-ai@${PI_VERSION}" "@mariozechner/pi-coding-agent@${PI_VERSION}" \
  && npm cache clean --force

COPY butler/ ./

RUN npm run build:web \
  && npm run build:server \
  && npm prune --omit=dev \
  && npm cache clean --force

FROM ${NODE_RUNTIME_IMAGE}

ARG CODEX_VERSION=0.124.0
ARG TTYD_VERSION=1.7.7

ENV NODE_ENV=production
ENV PATH="${PATH}:/opt/manor/npm-global/bin"

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    zsh \
    zsh-autosuggestions \
    zsh-syntax-highlighting \
  && rm -rf /var/lib/apt/lists/* \
  && arch="$(dpkg --print-architecture)" \
  && case "$arch" in \
    arm64) ttyd_arch="aarch64" ;; \
    amd64) ttyd_arch="x86_64" ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac \
  && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}" -o /usr/local/bin/ttyd \
  && chmod +x /usr/local/bin/ttyd \
  && mkdir -p /home/butler \
  && mkdir -p /home/butler/.oh-my-zsh/custom \
  && npm install --global --prefix /opt/manor/npm-global "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

COPY --from=build /opt/manor/butler/node_modules ./node_modules
COPY --from=build /opt/manor/butler/dist ./dist
COPY butler/index.html ./index.html
COPY butler/public ./public
COPY butler/tsconfig.json ./tsconfig.json
COPY butler/tsconfig.server.json ./tsconfig.server.json
COPY butler/vite.config.ts ./vite.config.ts
COPY docker/butler/start.sh /usr/local/bin/start-butler
COPY docker/butler/auth.sh /usr/local/bin/butler-auth
COPY docker/butler/chatgpt-login.mjs /usr/local/bin/butler-chatgpt-login.mjs
COPY docker/butler/terminal-shell.sh /usr/local/bin/start-butler-shell
COPY docker/codex-auto-update.sh /usr/local/bin/manor-codex-auto-update
COPY docker/pi-auto-update.sh /usr/local/bin/manor-pi-auto-update
COPY docker/butler/zshrc /home/butler/.zshrc
COPY docker/butler/zprofile /home/butler/.zprofile

RUN chmod +x /usr/local/bin/start-butler /usr/local/bin/butler-auth /usr/local/bin/butler-chatgpt-login.mjs /usr/local/bin/start-butler-shell /usr/local/bin/manor-codex-auto-update /usr/local/bin/manor-pi-auto-update \
  && rm -rf /tmp/* /var/tmp/*

EXPOSE 8080 7682

CMD ["/usr/local/bin/start-butler"]
