FROM mcr.microsoft.com/playwright:v1.55.0-noble

WORKDIR /opt/manor/playwright

RUN npm init -y \
  && npm install playwright@1.55.0

CMD ["bash", "-lc", "echo 'Playwright worker is running'; sleep infinity"]
