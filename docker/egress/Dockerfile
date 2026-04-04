FROM alpine:3.21

RUN apk add --no-cache squid

COPY docker/egress/squid.conf /etc/squid/squid.conf

CMD ["squid", "-N", "-f", "/etc/squid/squid.conf"]
