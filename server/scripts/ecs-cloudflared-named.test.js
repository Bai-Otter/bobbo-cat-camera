const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(
  path.join(__dirname, 'ecs-cloudflared-named.sh'),
  'utf8',
)

test('keeps tunnel credentials out of source and under the server secrets directory', () => {
  assert.match(source, /\/opt\/bobbo\/secrets\/cloudflared-named-token/)
  assert.match(source, /chmod 0600 "\$token_file"/)
  assert.doesNotMatch(source, /eyJ[A-Za-z0-9_-]{20,}/)
})

test('refuses to start the connector when the local backend is unhealthy', () => {
  assert.match(source, /origin_url="\$\{3:-http:\/\/127\.0\.0\.1:3000\}"/)
  assert.match(source, /\$\{origin_url\}\/health/)
  assert.match(source, /ExecStartPre=\/usr\/bin\/curl/)
})

test('allows an isolated loopback origin but rejects public origins', () => {
  assert.match(source, /origin URL must be an HTTP loopback address/)
  assert.match(source, /\^http:\/\/127\\\.0\\\.0\\\.1:/)
})

test('installs two independently supervised named tunnel connectors without touching NPort', () => {
  assert.match(source, /bobbo-cloudflared-named\.service/)
  assert.match(source, /bobbo-cloudflared-named-replica\.service/)
  assert.match(source, /After=network-online\.target/)
  assert.doesNotMatch(source, /After=.*bobbo-backend\.service/)
  assert.match(source, /Restart=always/)
  assert.match(source, /RestartSec=2/)
  assert.match(source, /write_unit .*'http2'/)
  assert.match(source, /write_unit .*'quic'/)
  assert.match(source, /systemctl enable "\$primary_service" "\$replica_service"/)
  assert.match(source, /systemctl restart "\$primary_service" "\$replica_service"/)
  assert.doesNotMatch(source, /systemctl (?:disable|stop|mask).*nport/)
})
