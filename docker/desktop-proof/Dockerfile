FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /opt/manor/desktop-proof

COPY docker/desktop-proof/desktop-proof-server.mjs /opt/manor/desktop-proof/desktop-proof-server.mjs
COPY docker/desktop-proof/start-desktop-proof.sh /usr/local/bin/start-desktop-proof

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    dbus-x11 \
    fluxbox \
    novnc \
    procps \
    scrot \
    websockify \
    wmctrl \
    xclip \
    x11vnc \
    x11-utils \
    xdotool \
    xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && chmod +x /usr/local/bin/start-desktop-proof

ENV DISPLAY=:99 \
  MANOR_DESKTOP_PROOF_PORT=3888 \
  MANOR_DESKTOP_PROOF_VNC_PORT=6080 \
  MANOR_DESKTOP_PROOF_RFB_PORT=5900

CMD ["/usr/local/bin/start-desktop-proof"]
