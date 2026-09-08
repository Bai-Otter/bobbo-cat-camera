function decodeDeviceIpHex(value) {
	const hex = String(value || '').trim().replace(/^0x/i, '')
	if (!/^[0-9a-f]{8}$/i.test(hex)) throw new Error('INVALID_DEVICE_IP_HEX')
	const bytes = hex.match(/.{2}/g)
	return bytes.reverse().map((byte) => parseInt(byte, 16)).join('.')
}

module.exports = {
	decodeDeviceIpHex
}
