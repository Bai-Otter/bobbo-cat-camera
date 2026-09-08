const PENDING_SHARE_INVITE_KEY = 'bobbo_pending_share_invite_v1'

function getApi(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function normalizeShareToken(value) {
	const token = String(value || '').trim()
	return /^[A-Za-z0-9_-]{16,32}$/.test(token) ? token : ''
}

function extractShareToken(options = {}) {
	return normalizeShareToken(
		(options.query && (options.query.scene || options.query.token)) || options.scene || options.token
	)
}

function captureShareToken(options = {}, uniApi) {
	const token = extractShareToken(options)
	return token ? savePendingShareToken(token, uniApi) : ''
}

function savePendingShareToken(tokenValue, uniApi) {
	const token = normalizeShareToken(tokenValue)
	const api = getApi(uniApi)
	if (token && api) api.setStorageSync(PENDING_SHARE_INVITE_KEY, token)
	return token
}

function readPendingShareToken(uniApi) {
	const api = getApi(uniApi)
	return normalizeShareToken(api ? api.getStorageSync(PENDING_SHARE_INVITE_KEY) : '')
}

function clearPendingShareToken(uniApi) {
	const api = getApi(uniApi)
	if (api) api.removeStorageSync(PENDING_SHARE_INVITE_KEY)
}

function postLoginRoute(uniApi) {
	const token = readPendingShareToken(uniApi)
	return token ? '/pages/share/accept?token=' + encodeURIComponent(token) : '/pages/today/index'
}

function shouldRoutePendingShare(options = {}) {
	return !!normalizeShareToken(options.token)
		&& !!options.hasSession
		&& !!options.startupResolved
		&& String(options.currentRoute || '') !== 'pages/share/accept'
}

module.exports = {
	PENDING_SHARE_INVITE_KEY,
	clearPendingShareToken,
	captureShareToken,
	extractShareToken,
	normalizeShareToken,
	postLoginRoute,
	readPendingShareToken,
	savePendingShareToken,
	shouldRoutePendingShare
}
