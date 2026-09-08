const STARTUP_SESSION_STATUS = Object.freeze({
	MISSING: 'missing',
	VALID: 'valid',
	INVALID: 'invalid',
	UNAVAILABLE: 'unavailable'
})

async function validateExistingSession(options = {}) {
	const authState = options.authState || {}
	if (!authState.hasSession || !(authState.profile && authState.profile.loggedIn)) {
		return { status: STARTUP_SESSION_STATUS.MISSING }
	}

	if (typeof options.requestProfile !== 'function') {
		throw new Error('STARTUP_SESSION_REQUEST_MISSING')
	}

	try {
		await options.requestProfile()
		return { status: STARTUP_SESSION_STATUS.VALID }
	} catch (error) {
		const latestAuthState = typeof options.readAuthState === 'function'
			? options.readAuthState()
			: authState
		if (!latestAuthState || !latestAuthState.hasSession) {
			return { status: STARTUP_SESSION_STATUS.INVALID, error }
		}
		return { status: STARTUP_SESSION_STATUS.UNAVAILABLE, error }
	}
}

async function refreshExistingSession(options = {}) {
	const authState = options.authState || {}
	if (!authState.hasSession || !(authState.profile && authState.profile.loggedIn)) {
		return { status: STARTUP_SESSION_STATUS.MISSING, refreshed: false }
	}

	try {
		if (typeof options.requestLoginCode !== 'function') throw new Error('WECHAT_LOGIN_CODE_REQUEST_MISSING')
		if (typeof options.loginBackend !== 'function') throw new Error('BACKEND_LOGIN_REQUEST_MISSING')
		if (typeof options.saveSession !== 'function') throw new Error('BACKEND_SESSION_SAVE_MISSING')
		const code = String(await options.requestLoginCode() || '').trim()
		if (!code) throw new Error('WECHAT_LOGIN_CODE_MISSING')
		const payload = await options.loginBackend(code)
		options.saveSession(payload || {})
		return { status: STARTUP_SESSION_STATUS.VALID, refreshed: true }
	} catch (error) {
		return { status: STARTUP_SESSION_STATUS.UNAVAILABLE, refreshed: false, error }
	}
}

module.exports = {
	STARTUP_SESSION_STATUS,
	refreshExistingSession,
	validateExistingSession
}
