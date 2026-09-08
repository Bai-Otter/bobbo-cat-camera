/**
 * 生成自签 HTTPS 证书 (用于本地开发)
 */
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");

(async () => {
  const attrs = [{ name: "commonName", value: "localhost" }];
  const opts = {
    keySize: 2048,
    days: 365,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true, clientAuth: true },
      { name: "subjectAltName", altNames: [
        { type: 2, value: "localhost" },
        { type: 2, value: "127.0.0.1" },
      ]},
    ],
  };
  const pems = await selfsigned.generate(attrs, opts);
  const certsDir = path.join(__dirname, "../../certs");
  fs.mkdirSync(certsDir, { recursive: true });
  fs.writeFileSync(path.join(certsDir, "server.key"), pems.private);
  fs.writeFileSync(path.join(certsDir, "server.crt"), pems.cert);
  console.log("证书已生成:");
  console.log("  key:", path.join(certsDir, "server.key"));
  console.log("  crt:", path.join(certsDir, "server.crt"));
})();
