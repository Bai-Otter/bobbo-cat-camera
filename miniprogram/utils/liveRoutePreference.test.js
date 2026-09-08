const test = require('node:test')
const assert = require('node:assert/strict')
const {
	ROUTE_HEALTH_TTL_MS,
	buildRouteOrder,
	clearHealthyRoute,
	markHealthyRoute,
	readHealthyRoute
} = require('./liveRoutePreference.js')

function makeApi() {
	const store = new Map()
	return {
		getStorageSync: (key) => store.get(key) || '',
		setStorageSync: (key, value) => store.set(key, value),
		removeStorageSync: (key) => store.delete(key)
	}
}

test('healthy live route is reused for thirty minutes', () => {
	const api = makeApi()
	clearHealthyRoute('SN1', api)
	markHealthyRoute('SN1', 'backend', api, 1000)
	assert.equal(readHealthyRoute('SN1', api, 2000), 'backend')
	assert.deepEqual(buildRouteOrder('SN1', api, 2000), ['backend', 'sdk'])
	assert.equal(readHealthyRoute('SN1', api, 1000 + ROUTE_HEALTH_TTL_MS + 1), '')
})

test('unknown route defaults to direct SDK then backend once', () => {
	const api = makeApi()
	clearHealthyRoute('SN2', api)
	assert.deepEqual(buildRouteOrder('SN2', api, 1000), ['sdk', 'backend'])
	assert.equal(markHealthyRoute('SN2', 'invalid', api), null)
})
