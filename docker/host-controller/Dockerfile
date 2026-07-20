FROM docker:28-cli

RUN apk add --no-cache bash curl git nodejs npm

WORKDIR /opt/manor/host-controller

RUN npm init -y \
  && npm install --omit=dev --no-audit --no-fund express \
  && npm cache clean --force

COPY docker/host-controller/controller.mjs docker/host-controller/controller-policy.mjs docker/host-controller/controller-activation.mjs docker/host-controller/source-state.mjs docker/host-controller/source-provenance.sh /opt/manor/host-controller/

RUN node --check /opt/manor/host-controller/controller.mjs \
  && node --check /opt/manor/host-controller/controller-policy.mjs \
  && node --check /opt/manor/host-controller/controller-activation.mjs \
  && node --check /opt/manor/host-controller/source-state.mjs \
  && chmod 755 /opt/manor/host-controller/source-provenance.sh

ENTRYPOINT ["node"]
CMD ["/opt/manor/host-controller/controller.mjs"]
