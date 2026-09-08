const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  proxyWebSocketUpgrade,
} = require("./dev-http-proxy.js");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.pipedTo = null;
    this.destroyed = false;
  }

  write(data) {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    return true;
  }

  pipe(target) {
    this.pipedTo = target;
    return target;
  }

  destroy() {
    this.destroyed = true;
  }
}

test("development proxy forwards WebSocket upgrades to the local HTTPS backend", () => {
  let requestOptions;
  const upstreamRequest = new EventEmitter();
  upstreamRequest.endCalled = false;
  upstreamRequest.end = () => { upstreamRequest.endCalled = true; };
  const httpsRequest = (options) => {
    requestOptions = options;
    return upstreamRequest;
  };
  const client = new FakeSocket();
  const clientHead = Buffer.from([1, 2, 3]);

  proxyWebSocketUpgrade(
    {
      method: "GET",
      url: "/api/devices/SN-1/media-control",
      headers: {
        host: "172.20.10.3:8000",
        connection: "Upgrade",
        upgrade: "websocket",
      },
    },
    client,
    clientHead,
    {
      targetHost: "127.0.0.1",
      targetPort: 3000,
      httpsRequest,
    }
  );

  assert.equal(requestOptions.hostname, "127.0.0.1");
  assert.equal(requestOptions.port, 3000);
  assert.equal(requestOptions.path, "/api/devices/SN-1/media-control");
  assert.equal(requestOptions.rejectUnauthorized, false);
  assert.equal(requestOptions.headers["x-forwarded-host"], "172.20.10.3:8000");
  assert.equal(requestOptions.headers["x-forwarded-proto"], "http");
  assert.equal(upstreamRequest.endCalled, true);

  const upstream = new FakeSocket();
  upstreamRequest.emit("upgrade", {
    statusCode: 101,
    statusMessage: "Switching Protocols",
    rawHeaders: ["Upgrade", "websocket", "Connection", "Upgrade"],
  }, upstream, Buffer.from([4, 5]));

  const handshake = client.writes[0].toString("utf8");
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(handshake, /Upgrade: websocket\r\n/);
  assert.deepEqual(upstream.writes[0], clientHead);
  assert.deepEqual(client.writes[1], Buffer.from([4, 5]));
  assert.equal(client.pipedTo, upstream);
  assert.equal(upstream.pipedTo, client);
});
