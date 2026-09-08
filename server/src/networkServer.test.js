const test = require("node:test");
const assert = require("node:assert/strict");

const { createNetworkServer } = require("./networkServer");

test("Cloud Hosting uses plain HTTP behind the platform HTTPS proxy", () => {
  const app = { name: "app" };
  let receivedApp = null;
  const expected = { protocol: "http" };
  const attached = [];

  const server = createNetworkServer({
    app,
    config: { cloudHosting: true },
    mediaControlGateway: {
      attach(server) {
        attached.push(server);
      },
    },
    httpModule: {
      createServer(value) {
        receivedApp = value;
        return expected;
      },
    },
    httpsModule: {
      createServer() {
        throw new Error("HTTPS must not be created in Cloud Hosting mode");
      },
    },
  });

  assert.equal(server, expected);
  assert.equal(receivedApp, app);
  assert.deepEqual(attached, [expected]);
});

test("self-hosting uses plain HTTP when TLS terminates at a reverse proxy", () => {
  const app = { name: "app" };
  const expected = { protocol: "http" };
  let receivedApp = null;

  const server = createNetworkServer({
    app,
    config: { cloudHosting: false, httpBehindProxy: true },
    httpModule: {
      createServer(value) {
        receivedApp = value;
        return expected;
      },
    },
    httpsModule: {
      createServer() {
        throw new Error("HTTPS must terminate at the reverse proxy");
      },
    },
  });

  assert.equal(server, expected);
  assert.equal(receivedApp, app);
});

test("local development keeps the existing certificate-backed HTTPS server", () => {
  const reads = [];
  let receivedOptions = null;
  const expected = { protocol: "https" };

  const server = createNetworkServer({
    app: { name: "app" },
    config: { cloudHosting: false },
    certsDir: "C:/certs",
    fsApi: {
      existsSync() {
        return true;
      },
      readFileSync(filePath) {
        reads.push(filePath);
        return `contents:${filePath}`;
      },
    },
    httpsModule: {
      createServer(options) {
        receivedOptions = options;
        return expected;
      },
    },
  });

  assert.equal(server, expected);
  assert.equal(reads.length, 2);
  assert.match(String(receivedOptions.key), /server\.key/);
  assert.match(String(receivedOptions.cert), /server\.crt/);
});
