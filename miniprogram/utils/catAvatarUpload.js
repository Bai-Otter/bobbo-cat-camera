function isRemoteAvatar(value) {
	return /^(cloud|https?):\/\//i.test(String(value || ''))
}

function readFileAsBase64(filePath, wxApi) {
	const manager = wxApi && typeof wxApi.getFileSystemManager === 'function'
		? wxApi.getFileSystemManager()
		: null
	if (!manager || typeof manager.readFile !== 'function') {
		return Promise.reject(new Error('CAT_AVATAR_FILE_READ_UNAVAILABLE'))
	}
	return new Promise((resolve, reject) => {
		manager.readFile({
			filePath,
			encoding: 'base64',
			success: (result) => {
				const data = String(result && result.data || '')
				if (!data) reject(new Error('CAT_AVATAR_FILE_READ_FAILED'))
				else resolve(data)
			},
			fail: () => reject(new Error('CAT_AVATAR_FILE_READ_FAILED'))
		})
	})
}

async function uploadSelfHostedAvatar({ filePath, catId, wxApi, uniApi, request } = {}) {
	const api = uniApi || (typeof uni !== 'undefined' ? uni : null)
	const requestApi = request || (api && api.request)
	if (!requestApi || typeof requestApi !== 'function') throw new Error('CAT_AVATAR_UPLOAD_UNAVAILABLE')
	const extension = /\.png(?:$|\?)/i.test(filePath) ? 'png' : /\.webp(?:$|\?)/i.test(filePath) ? 'webp' : 'jpg'
	const mimeType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg'
	const { BACKEND_RUNTIME } = require('../config/backend.js')
	const { buildUrl } = require('./backendClient.js')
	const { readAppAuthState } = require('./appAuth.js')
	const auth = readAppAuthState(api)
	const data = await readFileAsBase64(filePath, wxApi)
	const response = await new Promise((resolve, reject) => {
		requestApi({
			url: buildUrl('/api/cat-avatars', null, api, BACKEND_RUNTIME, wxApi),
			method: 'POST',
			data: { catId: String(catId || 'new'), mimeType, data },
			header: {
				'Content-Type': 'application/json',
				...(auth.sessionToken ? { 'X-Cat-Session': auth.sessionToken } : {})
			},
			success: resolve,
			fail: reject
		})
	})
	const statusCode = Number(response && response.statusCode)
	if (statusCode < 200 || statusCode >= 300) {
		const code = response && response.data && response.data.error
		throw new Error(String(code || 'CAT_AVATAR_UPLOAD_FAILED'))
	}
	const avatarUrl = String(response && response.data && response.data.avatarUrl || '')
	if (!avatarUrl) throw new Error('CAT_AVATAR_UPLOAD_FAILED')
	return avatarUrl
}

async function uploadCatAvatar(options = {}) {
	const filePath = String(options.filePath || '').trim()
	if (!filePath) throw new Error('CAT_AVATAR_REQUIRED')
	if (isRemoteAvatar(filePath)) return filePath
	const wxApi = options.wxApi || (typeof wx !== 'undefined' ? wx : null)
	const { BACKEND_RUNTIME, isCloudHosting } = require('../config/backend.js')
	const explicitCloudApi = options.wxApi && !options.uniApi && !options.request
	if (!isCloudHosting(BACKEND_RUNTIME) && !explicitCloudApi) {
		return uploadSelfHostedAvatar({ ...options, wxApi })
	}
	if (!wxApi || !wxApi.cloud || typeof wxApi.cloud.uploadFile !== 'function') {
		throw new Error('CAT_AVATAR_UPLOAD_UNAVAILABLE')
	}
	const safeId = String(options.catId || 'new').replace(/[^a-z0-9_-]/gi, '_').slice(0, 80)
	const extension = /\.png(?:$|\?)/i.test(filePath) ? 'png' : 'jpg'
	const uploaded = await wxApi.cloud.uploadFile({
		cloudPath: `cat-avatars/${safeId}/${Date.now()}.${extension}`,
		filePath
	})
	const fileId = String((uploaded && uploaded.fileID) || '')
	if (!fileId) throw new Error('CAT_AVATAR_UPLOAD_FAILED')
	return fileId
}

module.exports = { isRemoteAvatar, uploadCatAvatar, uploadSelfHostedAvatar }
