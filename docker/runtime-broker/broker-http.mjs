export function shouldBypassBrokerJsonParser(request) {
  return request.path.startsWith("/routes/preview/");
}

export function createBrokerJsonParserMiddleware(brokerJsonParser, shouldBypass = shouldBypassBrokerJsonParser) {
  return (request, response, next) => {
    if (shouldBypass(request)) {
      next();
      return;
    }
    brokerJsonParser(request, response, next);
  };
}
