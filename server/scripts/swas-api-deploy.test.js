const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const source = fs.readFileSync(path.join(__dirname, 'swas-api-deploy.sh'), 'utf8')

test('requires a verified offsite backup and confines deployment paths', () => {
  assert.match(source, /BOBBO_OFFSITE_BACKUP_VERIFIED/)
  assert.match(source, /refusing archive outside/)
  assert.match(source, /root='\/opt\/bobbo'/)
  assert.match(source, /incoming_root="\$\{root\}\/incoming"/)
  assert.doesNotMatch(source, /rm -rf \/opt\/bobbo/)
})

test('runs on the isolated SWAS port and rolls back an unhealthy release', () => {
  assert.match(source, /node-v22\.18\.0\/bin\/node/)
  assert.match(source, /node_major >= 22/)
  assert.match(source, /require\("node:sqlite"\)/)
  assert.match(source, /PORT=3101/)
  assert.match(source, /http:\/\/127\.0\.0\.1:3101\/health/)
  assert.match(source, /previous_target/)
  assert.match(
    source,
    /systemctl enable bobbo-backend\.service[\s\S]*systemctl restart bobbo-backend\.service[\s\S]*healthy=0/
  )
  assert.doesNotMatch(source, /systemctl enable --now bobbo-backend\.service/)
})

test('keeps runtime state outside releases and retains only three backups', () => {
  assert.match(source, /APP_DATA_STATE_FILE=\/opt\/bobbo\/data\/app-data\.sqlite/)
  assert.match(source, /for \(\(index=3;/)
  assert.match(source, /--exclude='opt\/bobbo\/data\/foodcast-temp'/)
})
