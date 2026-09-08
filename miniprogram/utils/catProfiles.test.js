const test = require('node:test')
const assert = require('node:assert/strict')

const {
	CAT_PROFILES_KEY,
	DEMO_CAT_PROFILES,
	catProfileKey,
	createCatEditorTarget,
	findCatProfileByKey,
	readCatProfiles,
	refreshCatProfiles,
	resolveActiveCat
} = require('./catProfiles')

function createStorage(initialValue) {
	let value = initialValue
	return {
		getStorageSync(key) {
			assert.equal(key, CAT_PROFILES_KEY)
			return value
		},
		setStorageSync(key, next) {
			assert.equal(key, CAT_PROFILES_KEY)
			value = next
		},
		read() {
			return value
		}
	}
}

test('cat profiles preserve a valid empty archive after all cats are deleted', () => {
	const storage = createStorage([])

	assert.deepEqual(readCatProfiles(storage), [])
	assert.deepEqual(storage.read(), [])
})

test('cat profiles parse stored profiles and return detached objects', () => {
	const storage = createStorage(JSON.stringify([
		{ id: 'xiaobu', name: '小布', avatar: 'wxfile://xiaobu' }
	]))
	const profiles = readCatProfiles(storage)

	assert.deepEqual(profiles, [{ id: 'xiaobu', name: '小布', avatar: 'wxfile://xiaobu' }])
	profiles[0].name = 'changed'
	assert.equal(JSON.parse(storage.read())[0].name, '小布')
})

test('cat profiles seed demo profiles only when storage is missing or invalid', () => {
	for (const stored of ['', '{invalid json', { id: 'not-an-array' }]) {
		const storage = createStorage(stored)
		const profiles = readCatProfiles(storage)

		assert.deepEqual(profiles, DEMO_CAT_PROFILES)
		assert.deepEqual(storage.read(), DEMO_CAT_PROFILES)
		assert.notStrictEqual(profiles, DEMO_CAT_PROFILES)
	}
})

test('active cat falls back to the first remaining profile when the previous cat was deleted', () => {
	const profiles = [{ id: 'xiaobu', name: '小布' }]

	assert.equal(resolveActiveCat(profiles, 'guagua'), profiles[0])
	assert.equal(resolveActiveCat(profiles, 'xiaobu'), profiles[0])
	assert.equal(resolveActiveCat([], 'xiaobu'), null)
})

test('shared-only accounts import their cached owned cats without copying shared profiles', async () => {
	const values = new Map([[CAT_PROFILES_KEY, [
		{ id: 'own-cat', name: '自己的猫', avatar: 'wxfile://own-cat' },
		{ id: 'shared-cat', name: '共享猫', source: 'shared', readOnly: true }
	]]])
	const storage = {
		getStorageSync: (key) => values.get(key) || '',
		setStorageSync: (key, value) => values.set(key, value)
	}
	const calls = []
	const shared = { id: 'shared-cat', catRef: 'cat_shared', name: '共享猫', source: 'shared', readOnly: true }
	const owned = { id: 'own-cat', catRef: 'cat_owned', name: '自己的猫', source: 'owned', readOnly: false }
	const result = await refreshCatProfiles({
		storage,
		accountId: 'openid-member',
		callBackend: async (url, options) => {
			calls.push([url, options])
			if (url === '/api/cats/import') return { cats: [owned, shared] }
			return { cats: [shared] }
		}
	})

	assert.deepEqual(calls.map(([url]) => url), ['/api/cats', '/api/cats/import'])
	assert.deepEqual(calls[1][1].data.cats.map((cat) => cat.id), ['own-cat'])
	assert.deepEqual(result.cats.map((cat) => cat.source), ['owned', 'shared'])
})

test('owned cat editor identity survives a cache refresh that adds catRef', () => {
	const cached = { id: 'own-cat', name: '自己的猫', avatar: 'wxfile://own-cat' }
	const refreshed = {
		id: 'own-cat',
		catRef: 'cat_owner_ref',
		name: '自己的猫',
		source: 'owned',
		readOnly: false
	}
	const target = createCatEditorTarget(cached)

	assert.equal(target.id, 'own-cat')
	assert.equal(target.readOnly, false)
	assert.equal(target.key, catProfileKey(refreshed))
	assert.equal(target.profile.id, 'own-cat')
})

test('owned and shared cats with the same raw id keep different editor identities', () => {
	const owned = { id: 'same-id', source: 'owned', readOnly: false }
	const shared = { id: 'same-id', catRef: 'cat_shared_ref', source: 'shared', readOnly: true }

	assert.equal(catProfileKey(owned), 'owned:same-id')
	assert.equal(catProfileKey(shared), 'shared:cat_shared_ref')
	assert.notEqual(catProfileKey(owned), catProfileKey(shared))
	assert.equal(createCatEditorTarget(shared).readOnly, true)
})

test('cat profile lookup resolves owned and shared cards by their stable profile keys', () => {
	const owned = { id: 'same-id', name: '自己的猫', source: 'owned', readOnly: false }
	const shared = { id: 'same-id', catRef: 'cat_shared_ref', name: '共享猫', source: 'shared', readOnly: true }
	const profiles = [owned, shared]

	assert.strictEqual(findCatProfileByKey(profiles, 'owned:same-id'), owned)
	assert.strictEqual(findCatProfileByKey(profiles, 'shared:cat_shared_ref'), shared)
	assert.equal(findCatProfileByKey(profiles, 'owned:missing'), null)
	assert.equal(findCatProfileByKey(profiles, ''), null)
})
