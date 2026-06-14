FROM docker:28-cli

RUN apk add --no-cache curl git nodejs npm

WORKDIR /opt/manor/host-controller

RUN npm init -y \
  && npm install --omit=dev --no-audit --no-fund express \
  && npm cache clean --force

COPY docker/host-controller/controller.mjs docker/host-controller/controller-policy.mjs /opt/manor/host-controller/

ENTRYPOINT ["node"]
CMD ["/opt/manor/host-controller/controller.mjs"]
