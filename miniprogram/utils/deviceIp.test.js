const test = require('node:test')
const assert = require('node:assert/strict')

const { decodeDeviceIpHex } = require('./deviceIp.js')

test('decodeDeviceIpHex converts the camera little-endian IPv4 payload', () => {
	assert.equal(decodeDeviceIpHex('020a14ac'), '172.20.10.2')
	assert.equal(decodeDeviceIpHex('0x5802a8c0'), '192.168.2.88')
})

test('decodeDeviceIpHex rejects malformed payloads', () => {
	assert.throws(() => decodeDeviceIpHex('020a14'), /INVALID_DEVICE_IP_HEX/)
})
