const test = require('node:test')
const assert = require('node:assert/strict')
const { isRemoteAvatar, uploadCatAvatar } = require('./catAvatarUpload.js')

test('cat avatar uploader preserves shared URLs and uploads local files', async () => {
	assert.equal(isRemoteAvatar('cloud://env/cat.jpg'), true)
	assert.equal(await uploadCatAvatar({ filePath: 'https://cdn.test/cat.jpg' }), 'https://cdn.test/cat.jpg')
	let request
	const fileId = await uploadCatAvatar({
		filePath: 'wxfile://tmp/cat.png',
		catId: 'cat/one',
		wxApi: { cloud: { uploadFile: async (value) => { request = value; return { fileID: 'cloud://cat-one' } } } }
	})
	assert.equal(fileId, 'cloud://cat-one')
	assert.equal(request.filePath, 'wxfile://tmp/cat.png')
	assert.match(request.cloudPath, /^cat-avatars\/cat_one\/\d+\.png$/)
})

test('cat avatar uploader rejects local files without cloud storage', async () => {
	await assert.rejects(uploadCatAvatar({ filePath: 'wxfile://tmp/cat.jpg', wxApi: {} }), { message: 'CAT_AVATAR_UPLOAD_UNAVAILABLE' })
})

test('cat avatar uploader posts local files to the self-hosted API', async () => {
	let request
	const wxApi = {
		getFileSystemManager: () => ({
			readFile: ({ success }) => success({ data: 'aGVsbG8=' })
		})
	}
	const uniApi = {
		getStorageSync: () => JSON.stringify({ sessionToken: 'session-token' }),
		request: (options) => {
			request = options
			options.success({ statusCode: 201, data: { avatarUrl: 'https://api.test/avatar.jpg' } })
		}
	}
	const avatarUrl = await uploadCatAvatar({ filePath: 'wxfile://tmp/cat.jpg', catId: 'cat-1', wxApi, uniApi })
	assert.equal(avatarUrl, 'https://api.test/avatar.jpg')
	assert.match(request.url, /\/api\/cat-avatars$/)
	assert.equal(request.data.catId, 'cat-1')
	assert.equal(request.data.data, 'aGVsbG8=')
	assert.equal(request.header['X-Cat-Session'], 'session-token')
})
