FROM node:22-bookworm

ARG CODEX_VERSION=0.118.0
ARG BUTLER_INSTALL_MODE=development

WORKDIR /opt/manor/butler

COPY butler/package.json butler/package-lock.json* ./

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
  && npm install

COPY butler/ ./
COPY docker/butler/start.sh /usr/local/bin/start-butler
COPY docker/butler/auth.sh /usr/local/bin/butler-auth
COPY docker/butler/chatgpt-login.mjs /usr/local/bin/butler-chatgpt-login.mjs

RUN chmod +x /usr/local/bin/start-butler /usr/local/bin/butler-auth /usr/local/bin/butler-chatgpt-login.mjs \
  && npm run build \
  && if [ "$BUTLER_INSTALL_MODE" = "production" ]; then npm prune --omit=dev; fi

EXPOSE 8080

CMD ["/usr/local/bin/start-butler"]
