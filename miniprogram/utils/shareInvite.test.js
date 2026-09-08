const test = require('node:test')
const assert = require('node:assert/strict')
const {
	clearPendingShareToken,
	captureShareToken,
	extractShareToken,
	postLoginRoute,
	readPendingShareToken,
	savePendingShareToken,
	shouldRoutePendingShare
} = require('./shareInvite.js')

function storage() {
	const values = new Map()
	return {
		getStorageSync: (key) => values.get(key) || '',
		setStorageSync: (key, value) => values.set(key, value),
		removeStorageSync: (key) => values.delete(key)
	}
}

test('share scene survives login navigation and clears after redeem', () => {
	const api = storage()
	const token = 'a'.repeat(32)
	assert.equal(extractShareToken({ query: { scene: token } }), token)
	assert.equal(savePendingShareToken(token, api), token)
	assert.equal(readPendingShareToken(api), token)
	assert.equal(postLoginRoute(api), '/pages/share/accept?token=' + token)
	clearPendingShareToken(api)
	assert.equal(postLoginRoute(api), '/pages/today/index')
})

test('share helper rejects malformed scenes', () => {
	const api = storage()
	assert.equal(extractShareToken({ scene: 'bad token' }), '')
	assert.equal(savePendingShareToken('short', api), '')
	assert.equal(readPendingShareToken(api), '')
})

test('captureShareToken stores scene from both cold and resumed launches', () => {
	const api = storage()
	const token = 'b'.repeat(32)
	assert.equal(captureShareToken({ scene: token }, api), token)
	assert.equal(readPendingShareToken(api), token)
	const nextToken = 'c'.repeat(32)
	assert.equal(captureShareToken({ query: { scene: nextToken } }, api), nextToken)
	assert.equal(readPendingShareToken(api), nextToken)
})

test('pending share routing waits for startup and never relaunches the accept page itself', () => {
	const token = 'd'.repeat(32)
	assert.equal(shouldRoutePendingShare({ token, hasSession: true, startupResolved: false, currentRoute: 'pages/launch/index' }), false)
	assert.equal(shouldRoutePendingShare({ token, hasSession: true, startupResolved: true, currentRoute: 'pages/today/index' }), true)
	assert.equal(shouldRoutePendingShare({ token, hasSession: false, startupResolved: true, currentRoute: 'pages/login/index' }), false)
	assert.equal(shouldRoutePendingShare({ token, hasSession: true, startupResolved: true, currentRoute: 'pages/share/accept' }), false)
})
