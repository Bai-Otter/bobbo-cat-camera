const http = require("node:http");
const https = require("node:https");

function forwardingHeaders(headers = {}, targetHost, targetPort) {
  return {
    ...headers,
    host: `${targetHost}:${targetPort}`,
    "x-forwarded-host": headers.host,
    "x-forwarded-proto": "http",
  };
}

function proxyHttpRequest(req, res, options = {}) {
  const targetHost = options.targetHost || "127.0.0.1";
  const targetPort = Number(options.targetPort || 3000);
  const httpsRequest = options.httpsRequest || https.request;
  const upstream = httpsRequest(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: forwardingHeaders(req.headers, targetHost, targetPort),
      rejectUnauthorized: false,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.statusCode = 502;
    res.end(`proxy error: ${error.message}`);
  });
  req.pipe(upstream);
  return upstream;
}

function rawResponseHeaders(response = {}) {
  if (Array.isArray(response.rawHeaders) && response.rawHeaders.length) {
    const lines = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`);
    }
    return lines;
  }
  return Object.entries(response.headers || {}).map(([name, value]) => {
    const headerValue = Array.isArray(value) ? value.join(", ") : value;
    return `${name}: ${headerValue}`;
  });
}

function writeUpgradeResponse(clientSocket, response = {}) {
  const statusCode = Number(response.statusCode) || 101;
  const statusMessage = response.statusMessage || "Switching Protocols";
  const lines = [`HTTP/1.1 ${statusCode} ${statusMessage}`, ...rawResponseHeaders(response), "", ""];
  clientSocket.write(lines.join("\r\n"));
}

function proxyWebSocketUpgrade(req, clientSocket, head, options = {}) {
  const targetHost = options.targetHost || "127.0.0.1";
  const targetPort = Number(options.targetPort || 3000);
  const httpsRequest = options.httpsRequest || https.request;
  const upstreamRequest = httpsRequest({
    hostname: targetHost,
    port: targetPort,
    path: req.url,
    method: req.method || "GET",
    headers: forwardingHeaders(req.headers, targetHost, targetPort),
    rejectUnauthorized: false,
  });

  upstreamRequest.once("upgrade", (response, upstreamSocket, upstreamHead) => {
    writeUpgradeResponse(clientSocket, response);
    if (head && head.length) upstreamSocket.write(head);
    if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  });
  upstreamRequest.once("response", (response) => {
    writeUpgradeResponse(clientSocket, response);
    response.pipe(clientSocket);
  });
  upstreamRequest.once("error", (error) => {
    if (!clientSocket.destroyed) clientSocket.destroy(error);
  });
  clientSocket.once?.("error", () => {
    upstreamRequest.destroy?.();
  });
  upstreamRequest.end();
  return upstreamRequest;
}

function createProxyServer(options = {}) {
  const targetHost = options.targetHost || "127.0.0.1";
  const targetPort = Number(options.targetPort || 3000);
  const server = http.createServer((req, res) => proxyHttpRequest(req, res, {
    targetHost,
    targetPort,
    httpsRequest: options.httpsRequest,
  }));
  server.on("upgrade", (req, socket, head) => proxyWebSocketUpgrade(req, socket, head, {
    targetHost,
    targetPort,
    httpsRequest: options.httpsRequest,
  }));
  return server;
}

function startDevelopmentProxy(options = {}) {
  const listenHost = options.listenHost || process.env.DEV_PROXY_HOST || "0.0.0.0";
  const listenPort = Number(options.listenPort || process.env.DEV_PROXY_PORT || process.env.HTTP_PORT || 8000);
  const targetHost = options.targetHost || process.env.DEV_PROXY_TARGET_HOST || "127.0.0.1";
  const targetPort = Number(options.targetPort || process.env.DEV_PROXY_TARGET_PORT || process.env.PORT || 3000);
  const server = createProxyServer({ targetHost, targetPort });
  server.listen(listenPort, listenHost, () => {
    console.log(`[dev-proxy] http://${listenHost}:${listenPort} -> https://${targetHost}:${targetPort} (HTTP + WebSocket)`);
  });
  return server;
}

if (require.main === module) startDevelopmentProxy();

module.exports = {
  createProxyServer,
  forwardingHeaders,
  proxyHttpRequest,
  proxyWebSocketUpgrade,
  startDevelopmentProxy,
  writeUpgradeResponse,
};
