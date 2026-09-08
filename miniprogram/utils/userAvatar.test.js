const test = require('node:test')
const assert = require('node:assert/strict')

const {
	isPersistedUserAvatar,
	preferUserAvatar,
	uploadUserAvatar
} = require('./userAvatar.js')

test('user avatars are persisted only when they have a cross-device URL', () => {
	assert.equal(isPersistedUserAvatar('https://mini-api.example/avatar.jpg'), true)
	assert.equal(isPersistedUserAvatar('cloud://env/avatar.jpg'), true)
	assert.equal(isPersistedUserAvatar('wxfile://store/avatar.jpg'), false)
	assert.equal(isPersistedUserAvatar('http://tmp/avatar.jpg'), true)
})

test('a remote avatar is never replaced by an empty or device-local value', () => {
	assert.equal(
		preferUserAvatar('https://mini-api.example/avatar.jpg', 'wxfile://store/stale.jpg'),
		'https://mini-api.example/avatar.jpg'
	)
	assert.equal(
		preferUserAvatar('wxfile://store/avatar.jpg', ''),
		'wxfile://store/avatar.jpg'
	)
})

test('self-hosted user avatar upload reuses the authenticated media endpoint', async () => {
	let request = null
	const wxApi = {
		getFileSystemManager() {
			return {
				readFile(options) { options.success({ data: 'YWJj' }) }
			}
		}
	}
	const uniApi = {
		getStorageSync(key) {
			if (key === 'catBackendSession') return JSON.stringify({ sessionToken: 'session-token', openid: 'owner-1' })
			if (key === 'catBackendBaseUrl') return 'https://mini-api.example'
			return ''
		},
		request(options) {
			request = options
			options.success({ statusCode: 201, data: { avatarUrl: 'https://mini-api.example/media/cat-avatars/profile.jpg' } })
		}
	}

	const result = await uploadUserAvatar({ filePath: 'wxfile://tmp/avatar.jpg', wxApi, uniApi })
	assert.equal(result, 'https://mini-api.example/media/cat-avatars/profile.jpg')
	assert.match(request.url, /\/api\/cat-avatars$/)
	assert.equal(request.data.catId, 'profile')
	assert.equal(request.header['X-Cat-Session'], 'session-token')
})
