FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /opt/manor/playwright

COPY docker/playwright/browser-use-server.mjs /opt/manor/playwright/browser-use-server.mjs
COPY docker/playwright/start-browser-use.sh /usr/local/bin/start-browser-use

RUN npm init -y \
  && npm install playwright@1.59.1 \
  && chmod +x /usr/local/bin/start-browser-use

CMD ["/usr/local/bin/start-browser-use"]
