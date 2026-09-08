const test = require('node:test')
const assert = require('node:assert/strict')

const {
	STARTUP_SESSION_STATUS,
	refreshExistingSession,
	validateExistingSession
} = require('./appLaunch.js')

function loggedInAuthState() {
	return {
		hasSession: true,
		profile: { loggedIn: true }
	}
}

test('startup validation accepts a backend session that can read the profile', async () => {
	let requests = 0
	const result = await validateExistingSession({
		authState: loggedInAuthState(),
		requestProfile: async () => {
			requests += 1
			return { profile: {} }
		}
	})

	assert.equal(requests, 1)
	assert.equal(result.status, STARTUP_SESSION_STATUS.VALID)
})

test('startup validation reports invalid after a 401 clears the stored session', async () => {
	let hasSession = true
	const result = await validateExistingSession({
		authState: loggedInAuthState(),
		requestProfile: async () => {
			hasSession = false
			throw new Error('AUTH_REQUIRED')
		},
		readAuthState: () => ({ hasSession })
	})

	assert.equal(result.status, STARTUP_SESSION_STATUS.INVALID)
})

test('startup validation keeps an existing session during a temporary network outage', async () => {
	const result = await validateExistingSession({
		authState: loggedInAuthState(),
		requestProfile: async () => {
			throw new Error('BACKEND_NETWORK_FAILED')
		},
		readAuthState: () => loggedInAuthState()
	})

	assert.equal(result.status, STARTUP_SESSION_STATUS.UNAVAILABLE)
})

test('startup validation skips backend access when no complete session exists', async () => {
	let requested = false
	const result = await validateExistingSession({
		authState: { hasSession: false, profile: { loggedIn: false } },
		requestProfile: async () => {
			requested = true
		}
	})

	assert.equal(requested, false)
	assert.equal(result.status, STARTUP_SESSION_STATUS.MISSING)
})

test('startup silently refreshes an existing WeChat backend session', async () => {
	let savedPayload
	const result = await refreshExistingSession({
		authState: loggedInAuthState(),
		requestLoginCode: async () => 'fresh-wechat-code',
		loginBackend: async (code) => ({
			code,
			sessionToken: 'fresh-session',
			user: { openid: 'openid-owner' }
		}),
		saveSession: (payload) => {
			savedPayload = payload
		}
	})

	assert.equal(result.status, STARTUP_SESSION_STATUS.VALID)
	assert.equal(result.refreshed, true)
	assert.equal(savedPayload.sessionToken, 'fresh-session')
	assert.equal(savedPayload.code, 'fresh-wechat-code')
})

test('startup keeps the old session when silent refresh is temporarily unavailable', async () => {
	const result = await refreshExistingSession({
		authState: loggedInAuthState(),
		requestLoginCode: async () => {
			throw new Error('wx.login unavailable')
		},
		loginBackend: async () => {
			throw new Error('must not run')
		},
		saveSession: () => {
			throw new Error('must not run')
		}
	})

	assert.equal(result.status, STARTUP_SESSION_STATUS.UNAVAILABLE)
	assert.equal(result.refreshed, false)
})
