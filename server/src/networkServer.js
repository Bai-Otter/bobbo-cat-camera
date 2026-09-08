const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

function createNetworkServer({
  app,
  config,
  certsDir = path.join(__dirname, "../../certs"),
  fsApi = fs,
  httpModule = http,
  httpsModule = https,
  mediaControlGateway = null,
} = {}) {
  let server;
  if (config && (config.cloudHosting || config.httpBehindProxy)) {
    server = httpModule.createServer(app);
  } else {
    const keyPath = path.join(certsDir, "server.key");
    const certPath = path.join(certsDir, "server.crt");
    if (!fsApi.existsSync(keyPath) || !fsApi.existsSync(certPath)) {
      throw new Error(`HTTPS_CERTIFICATES_MISSING:${keyPath}:${certPath}`);
    }

    server = httpsModule.createServer(
      {
        key: fsApi.readFileSync(keyPath),
        cert: fsApi.readFileSync(certPath),
      },
      app
    );
  }
  mediaControlGateway?.attach(server);
  return server;
}

module.exports = { createNetworkServer };
