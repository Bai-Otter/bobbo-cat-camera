const { readAppAuthState } = require('./appAuth.js')
const {
	BACKEND_RUNTIME,
	getCloudContainerOptions,
	isCloudHosting
} = require('../config/backend.js')

function getUni(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function getWx(api) {
	if (typeof wx !== 'undefined') return wx
	return api && api.cloud ? api : null
}

function getResponseHeader(response, name) {
	const headers = (response && (response.header || response.headers)) || {}
	const expected = String(name || '').toLowerCase()
	const key = Object.keys(headers).find((item) => item.toLowerCase() === expected)
	return key ? String(headers[key] || '') : ''
}

function getRequestPath(sourceUrl) {
	const schemeIndex = sourceUrl.indexOf('://')
	if (schemeIndex < 0) return sourceUrl.startsWith('/') ? sourceUrl : '/' + sourceUrl
	const pathIndex = sourceUrl.indexOf('/', schemeIndex + 3)
	return pathIndex >= 0 ? sourceUrl.slice(pathIndex) : '/'
}

function arrayBufferToDataUri(response, wxApi) {
	const data = response && response.data
	if (!data || !wxApi || typeof wxApi.arrayBufferToBase64 !== 'function') {
		throw new Error('QR_IMAGE_BINARY_INVALID')
	}
	const contentType = getResponseHeader(response, 'content-type') || 'image/png'
	return `data:${contentType};base64,${wxApi.arrayBufferToBase64(data)}`
}

function downloadFromCloudHosting(sourceUrl, api, wxApi, runtime) {
	const cloud = wxApi && wxApi.cloud
	const container = getCloudContainerOptions(runtime)
	if (!cloud || typeof cloud.callContainer !== 'function') {
		return Promise.reject(new Error('CLOUD_CONTAINER_UNAVAILABLE'))
	}
	if (!container.env || !container.serviceName) {
		return Promise.reject(new Error('CLOUD_HOSTING_CONFIG_MISSING'))
	}
	const authState = readAppAuthState(api || wxApi)
	const header = { 'X-WX-SERVICE': container.serviceName }
	if (authState.sessionToken) header['X-Cat-Session'] = authState.sessionToken

	return new Promise((resolve, reject) => {
		let settled = false
		const succeed = (response) => {
			if (settled) return
			settled = true
			const statusCode = Number((response && response.statusCode) || 200)
			if (statusCode < 200 || statusCode >= 300) {
				reject(new Error('QR_IMAGE_DOWNLOAD_' + statusCode))
				return
			}
			try {
				resolve(arrayBufferToDataUri(response, wxApi))
			} catch (error) {
				reject(error)
			}
		}
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(new Error((error && (error.errMsg || error.message)) || 'QR_IMAGE_DOWNLOAD_FAILED'))
		}
		try {
			const result = cloud.callContainer({
				config: { env: container.env },
				path: getRequestPath(sourceUrl),
				method: 'GET',
				header,
				responseType: 'arraybuffer',
				success: succeed,
				fail
			})
			if (result && typeof result.then === 'function') result.then(succeed).catch(fail)
		} catch (error) {
			fail(error)
		}
	})
}

function downloadQrImage(url, uniApi, runtime = BACKEND_RUNTIME) {
	const api = getUni(uniApi)
	const wxApi = getWx(api)
	const sourceUrl = String(url || '').trim()
	if (!sourceUrl) return Promise.reject(new Error('QR_IMAGE_URL_REQUIRED'))
	if (isCloudHosting(runtime) && wxApi && wxApi.cloud) {
		return downloadFromCloudHosting(sourceUrl, api, wxApi, runtime)
	}
	if (!api || typeof api.downloadFile !== 'function') {
		return Promise.reject(new Error('QR_IMAGE_DOWNLOAD_UNAVAILABLE'))
	}
	const authState = typeof api.getStorageSync === 'function'
		? readAppAuthState(api)
		: { sessionToken: '' }
	const header = {}
	if (authState.sessionToken) header['X-Cat-Session'] = authState.sessionToken
	return new Promise((resolve, reject) => {
		api.downloadFile({
			url: sourceUrl,
			header,
			success(response) {
				const statusCode = Number(response && response.statusCode)
				const tempFilePath = String((response && response.tempFilePath) || '')
				if (statusCode >= 200 && statusCode < 300 && tempFilePath) {
					resolve(tempFilePath)
					return
				}
				reject(new Error('QR_IMAGE_DOWNLOAD_' + (statusCode || 'FAILED')))
			},
			fail(error) {
				reject(new Error((error && (error.errMsg || error.message)) || 'QR_IMAGE_DOWNLOAD_FAILED'))
			}
		})
	})
}

function requestQrImage(path, options = {}, uniApi, runtime = BACKEND_RUNTIME) {
	const api = getUni(uniApi)
	const wxApi = getWx(api)
	const authState = readAppAuthState(api || wxApi)
	const method = options.method || 'POST'
	const header = Object.assign({ 'Content-Type': 'application/json' }, options.header || {})
	if (authState.sessionToken) header['X-Cat-Session'] = authState.sessionToken
	if (isCloudHosting(runtime)) {
		const cloud = wxApi && wxApi.cloud
		const container = getCloudContainerOptions(runtime)
		if (!cloud || typeof cloud.callContainer !== 'function') return Promise.reject(new Error('CLOUD_CONTAINER_UNAVAILABLE'))
		return new Promise((resolve, reject) => {
			cloud.callContainer({
				config: { env: container.env },
				path,
				method,
				data: options.data || {},
				header: Object.assign(header, { 'X-WX-SERVICE': container.serviceName }),
				responseType: 'arraybuffer',
				success: (response) => {
					try { resolve(arrayBufferToDataUri(response, wxApi)) } catch (error) { reject(error) }
				},
				fail: reject
			})
		})
	}
	if (!api || typeof api.request !== 'function') return Promise.reject(new Error('QR_IMAGE_DOWNLOAD_UNAVAILABLE'))
	const { buildUrl } = require('./backendClient.js')
	return new Promise((resolve, reject) => {
		api.request({
			url: buildUrl(path, null, api, runtime, wxApi),
			method,
			data: options.data || {},
			header,
			responseType: 'arraybuffer',
			success: (response) => {
				if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) {
					reject(new Error('QR_IMAGE_DOWNLOAD_' + response.statusCode))
					return
				}
				try { resolve(arrayBufferToDataUri(response, wxApi)) } catch (error) { reject(error) }
			},
			fail: reject
		})
	})
}

module.exports = { downloadQrImage, requestQrImage }
