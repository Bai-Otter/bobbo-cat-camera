const PENDING_DEVICE_BIND_KEY = 'catPendingDeviceBind'

function getUni(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function readJsonStorage(key, fallback, uniApi) {
	const api = getUni(uniApi)
	if (!api) return fallback
	const raw = api.getStorageSync(key)
	if (!raw) return fallback
	if (typeof raw !== 'string') return raw
	try {
		return JSON.parse(raw)
	} catch (err) {
		return fallback
	}
}

function decodeHexAscii(value) {
	const input = String(value || '').trim()
	if (!input || input.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(input)) return input
	let output = ''
	for (let index = 0; index < input.length; index += 2) {
		const code = parseInt(input.slice(index, index + 2), 16)
		if (code < 32 || code > 126) return input
		output += String.fromCharCode(code)
	}
	return output
}

function firstValue(values) {
	for (const value of values) {
		const clean = String(value || '').trim()
		if (clean) return clean
	}
	return ''
}

function buildDeviceBindDraft(config = {}) {
	const directSn = firstValue([config.deviceNo, config.serialNumber, config.sn, config.deviceSn])
	const devIdSn = decodeHexAscii(firstValue([config.devId, config.devid, config.deviceIdHex]))
	const adminToken = decodeHexAscii(firstValue([config.adminToken, config.bindToken, config.token]))
	return {
		sn: directSn || devIdSn,
		username: decodeHexAscii(firstValue([config.userName, config.username])) || 'admin',
		password: decodeHexAscii(firstValue([config.password, config.passWord, config.devicePassword])),
		nickname: firstValue([config.nickname]) || '猫饭摄像头',
		ip: firstValue([config.devIp, config.ip, config.ipAddress]),
		port: firstValue([config.port, config.devicePort]),
		adminToken
	}
}

function savePendingDeviceBind(config = {}, uniApi) {
	const api = getUni(uniApi)
	const draft = buildDeviceBindDraft(config)
	const pending = {
		sn: draft.sn,
		username: draft.username,
		password: '',
		nickname: draft.nickname,
		ip: draft.ip,
		port: draft.port,
		savedAt: Date.now()
	}
	if (api) api.setStorageSync(PENDING_DEVICE_BIND_KEY, JSON.stringify(pending))
	return pending
}

function readPendingDeviceBind(uniApi) {
	const pending = readJsonStorage(PENDING_DEVICE_BIND_KEY, null, uniApi)
	if (!pending || !pending.sn) return null
	return Object.assign({ username: 'admin', password: '', nickname: '猫饭摄像头', ip: '', port: '' }, pending)
}

function clearPendingDeviceBind(uniApi) {
	const api = getUni(uniApi)
	if (api) api.removeStorageSync(PENDING_DEVICE_BIND_KEY)
}

module.exports = {
	PENDING_DEVICE_BIND_KEY,
	buildDeviceBindDraft,
	clearPendingDeviceBind,
	readPendingDeviceBind,
	savePendingDeviceBind
}
