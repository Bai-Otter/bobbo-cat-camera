const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  JFDevicePriClient,
  buildHttpPlaybackCommand,
  buildPlaybackWebSocketUrl,
  targetSecToLocalTime,
} = require("./devicePriClient");

test("buildHttpPlaybackCommand creates native playback control payloads", () => {
  const start = buildHttpPlaybackCommand({
    opr: "StartPlay",
    salt: "salt-1",
    channel: 0,
    stream: "Main",
    beginTime: "2026-07-11 10:00:00",
    fileName: "/idea0/clip.h264",
    targetSec: 42,
  });

  assert.deepEqual(start, {
    Name: "HttpPlayBack",
    Salt: "salt-1",
    HttpPlayBack: {
      Opr: "StartPlay",
      PlayMode: "PlayByName",
      Channel: 0,
      Stream: "Main",
      ExactSeek: 1,
      PlayByName: {
        LocalTime: "2026-07-11 10:00:42",
        FileName: "/idea0/clip.h264",
      },
    },
  });

  const locate = buildHttpPlaybackCommand({
    opr: "Locate",
    salt: "salt-1",
    channel: 0,
    stream: "Main",
    beginTime: "2026-07-11 10:00:00",
    targetSec: 65,
  });

  assert.deepEqual(locate, {
    Name: "HttpPlayBack",
    Salt: "salt-1",
    HttpPlayBack: {
      Opr: "Locate",
      Channel: 0,
      Stream: "Main",
      LocateTime: "2026-07-11 10:01:05",
    },
  });

  assert.deepEqual(
    buildHttpPlaybackCommand({ opr: "Pause", salt: "salt-1", channel: 1, stream: "Sub" }),
    {
      Name: "HttpPlayBack",
      Salt: "salt-1",
      HttpPlayBack: { Opr: "Pause", Channel: 1, Stream: "Sub" },
    }
  );
});

test("targetSecToLocalTime preserves device local timestamp formatting", () => {
  assert.equal(targetSecToLocalTime("2026-07-11 23:59:58", 5), "2026-07-12 00:00:03");
  assert.equal(targetSecToLocalTime("2026-07-11T10:00:00", 0), "2026-07-11 10:00:00");
});

test("buildPlaybackWebSocketUrl targets the inferred HttpPlayBack native endpoint", () => {
  assert.equal(
    buildPlaybackWebSocketUrl({
      host: "192.168.4.1",
      wsPort: 8080,
      secure: false,
      salt: "salt 1",
      channel: 0,
      stream: "Main",
    }),
    "ws://192.168.4.1:8080/websocket-bin/Type=HttpPlayBack?Salt=salt%201&Channel=0&Stream=Main&XMHead=1"
  );
});

test("JFDevicePriClient login posts RSA payloads without raw secrets", async () => {
  const posts = [];
  const encryptedInputs = [];
  const client = new JFDevicePriClient({
    host: "192.168.4.1",
    httpPort: 80,
    username: "admin",
    password: "pw",
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      posts.push({ url, body });
      if (body.Name === "GetPreLoginInfo") return jsonResponse({ Ret: 100, TCPPort: 34567 });
      if (body.Name === "GetSalt") {
        return jsonResponse({
          Ret: 100,
          Salt: "salt-1",
          PublicKey: "aabbcc,10001",
          LoginEncryptionType: "RSA",
        });
      }
      return jsonResponse({ Ret: 100, DeviceType: "IPC" });
    },
    encrypt: (value) => {
      encryptedInputs.push(value);
      return "cipher-" + encryptedInputs.length;
    },
    randomHex: () => "ab".repeat(48),
    setInterval: () => 123,
    clearInterval: () => {},
  });

  await client.login();

  assert.equal(posts[0].body.Name, "GetPreLoginInfo");
  assert.equal(posts[1].body.Name, "GetSalt");
  assert.equal(posts[2].body.Name, "Login");
  assert.equal(posts[2].body.User, "cipher-1");
  assert.equal(posts[2].body.Sign, "cipher-2");
  assert.equal(posts[2].body.VERK, "cipher-3");
  assert.deepEqual(encryptedInputs, [
    "admin",
    "salt-18fe4c11451281c094a6578e6ddbf5eed",
    "ab".repeat(48),
  ]);
  assert.doesNotMatch(JSON.stringify(posts[2].body), /admin|pw/);
});

test("JFDevicePriClient allows devices configured with an empty admin password", async () => {
  const encryptedInputs = [];
  const client = new JFDevicePriClient({
    host: "192.168.4.1",
    username: "admin",
    password: "",
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.Name === "GetPreLoginInfo") return jsonResponse({ Ret: 100 });
      if (body.Name === "GetSalt") {
        return jsonResponse({ Ret: 100, Salt: "salt-1", PublicKey: "aabbcc,10001" });
      }
      return jsonResponse({ Ret: 100 });
    },
    encrypt: (value) => {
      encryptedInputs.push(value);
      return "cipher";
    },
    setInterval: () => 123,
    clearInterval: () => {},
  });

  await client.login();

  assert.equal(encryptedInputs[1], "salt-1d41d8cd98f00b204e9800998ecf8427e");
});

test("JFDevicePriClient sends native seek and stop commands through websocket.cgi", async () => {
  const commands = [];
  const client = new JFDevicePriClient({
    host: "192.168.4.1",
    httpPort: 80,
    username: "admin",
    password: "pw",
    fetch: async (url, options) => {
      commands.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ Ret: 100 });
    },
  });
  client.salt = "salt-1";

  await client.seekTo({ channel: 0, stream: "Main", beginTime: "2026-07-11 10:00:00", targetSec: 3 });
  await client.stopPlayback({ channel: 0, stream: "Main" });

  assert.equal(commands[0].url, "http://192.168.4.1:80/cgi-bin/websocket.cgi");
  assert.equal(commands[0].body.HttpPlayBack.Opr, "Locate");
  assert.equal(commands[0].body.HttpPlayBack.LocateTime, "2026-07-11 10:00:03");
  assert.equal(commands[1].body.HttpPlayBack.Opr, "StopPlay");
});

test("JFDevicePriClient can connect playback websocket and relay binary chunks", async () => {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      sockets.push(this);
    }
    close() {
      this.closed = true;
      this.emit("close");
    }
  }

  const chunks = [];
  const client = new JFDevicePriClient({
    host: "192.168.4.1",
    username: "admin",
    password: "pw",
    WebSocket: FakeWebSocket,
  });
  client.salt = "salt-1";

  const connection = client.connectPlaybackStream({
    channel: 0,
    stream: "Main",
    onData: (chunk) => chunks.push(chunk),
  });

  sockets[0].emit("message", Buffer.from("FLV"));

  assert.equal(sockets[0].url, "ws://192.168.4.1/websocket-bin/Type=HttpPlayBack?Salt=salt-1&Channel=0&Stream=Main&XMHead=1");
  assert.deepEqual(chunks, [Buffer.from("FLV")]);

  connection.close();
  assert.equal(sockets[0].closed, true);
});

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}
