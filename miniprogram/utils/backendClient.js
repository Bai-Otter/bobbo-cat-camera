const {
	clearAppSession,
	getBackendBaseUrl,
	readAppAuthState,
	saveAppSession
} = require('./appAuth.js')
const {
	BACKEND_RUNTIME,
	getBackendBaseUrl: getConfiguredBackendBaseUrl,
	getCloudContainerOptions,
	isCloudHosting
} = require('../config/backend.js')

function getUni(uniApi) {
	return uniApi || (typeof uni !== 'undefined' ? uni : null)
}

function buildPath(path, query) {
	const cleanPath = String(path || '').startsWith('/') ? String(path || '') : '/' + String(path || '')
	const params = query || {}
	const queryString = Object.keys(params)
		.filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
		.map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])))
		.join('&')
	return cleanPath + (queryString ? '?' + queryString : '')
}

function getRequestBaseUrl(uniApi, backendRuntime = BACKEND_RUNTIME, wxApi) {
	if (isCloudHosting(backendRuntime)) return getConfiguredBackendBaseUrl(backendRuntime)
	const accountApi = wxApi || getWx({})
	let envVersion = ''
	try {
		envVersion = String(accountApi && accountApi.getAccountInfoSync && accountApi.getAccountInfoSync().miniProgram && accountApi.getAccountInfoSync().miniProgram.envVersion || '').toLowerCase()
	} catch (error) {}
	const environmentBaseUrl = envVersion === 'develop'
		? backendRuntime && backendRuntime.developmentBaseUrl
		: envVersion === 'trial'
			? backendRuntime && backendRuntime.trialBaseUrl
			: ''
	return String(environmentBaseUrl || getBackendBaseUrl(uniApi, backendRuntime) || '').trim().replace(/\/+$/, '')
}

function buildUrl(path, query, uniApi, backendRuntime = BACKEND_RUNTIME, wxApi) {
	return getRequestBaseUrl(uniApi, backendRuntime, wxApi) + buildPath(path, query)
}

function toErrorMessage(response) {
	const data = response && response.data
	if (data && typeof data === 'object') {
		const detailsMessage = data.details && typeof data.details === 'object' ? data.details.message : ''
		return data.detail || detailsMessage || data.error || data.message || JSON.stringify(data)
	}
	if (data) return String(data)
	return 'BACKEND_REQUEST_FAILED'
}

function toBackendError(response) {
	const error = new Error(toErrorMessage(response))
	const data = response && response.data
	const details = data && typeof data === 'object' && data.details && typeof data.details === 'object' ? data.details : {}
	error.code = data && typeof data === 'object' ? String(data.error || '') : ''
	error.statusCode = Number(response && response.statusCode) || 0
	error.requestId = String(details.requestId || (data && data.requestId) || '')
	error.details = details
	error.responseData = data && typeof data === 'object'
		? { error: data.error || '', details }
		: String(data || '')
	return error
}

function getBackendErrorMessage(error, fallback = '请求失败') {
	const message = String((error && error.message) || error || '')
	if (message.indexOf('DEVICE_ALREADY_BOUND_TO_OTHER_ACCOUNT') >= 0 || message.indexOf('29013') >= 0) {
		return '设备已绑定到其他账户'
	}
	if (message.indexOf('JF_CONFIG_MISSING') >= 0) {
		return '后台缺少 JF 配置，请检查服务配置'
	}
	if (message.indexOf('BACKEND_NETWORK_FAILED') >= 0 || message.indexOf('ERR_CONNECTION_REFUSED') >= 0) {
		return '后台服务连接失败，请确认服务已启动'
	}
	if (message.indexOf('CLOUD_HOSTING_CONFIG_MISSING') >= 0) return '云托管服务尚未配置完成'
	if (message.indexOf('CLOUD_CONTAINER_UNAVAILABLE') >= 0) return '当前环境无法连接云托管服务'
	if (message.indexOf('WECHAT_LOGIN_NOT_CONFIGURED') >= 0) return '本机服务缺少微信 AppSecret'
	if (message.indexOf('WECHAT_LOGIN_PROVIDER_ERROR') >= 0) return '微信登录凭证已失效，请重试'
	if (message.indexOf('REPLAY_HLS_START_TIMEOUT') >= 0) return '录像连接超时，请重试'
	if (message.indexOf('REPLAY_HLS_START_FAILED') >= 0) return '录像启动失败，请重试'
	return fallback
}

function getWx(options) {
	return options.wxApi || (typeof wx !== 'undefined' ? wx : null)
}

let sessionRenewalPromise = null

function handleResponse(response, resolve, reject, api) {
	const statusCode = Number(response && response.statusCode)
	if (statusCode >= 200 && statusCode < 300) {
		resolve(response.data || {})
		return
	}
	reject(toBackendError(response))
}

function invalidateMutationCache(path, method, api) {
	try {
		const { invalidatePageDataForMutation } = require('./pageDataCache.js')
		invalidatePageDataForMutation(path, method, api)
	} catch (error) {
		console.warn('[cache] mutation invalidation failed', String(error && error.message || error))
	}
}

function callCloudContainer(path, options, api, runtime, authState) {
	const wxApi = getWx(options)
	const cloud = wxApi && wxApi.cloud
	const container = getCloudContainerOptions(runtime)
	if (!cloud || typeof cloud.callContainer !== 'function') return Promise.reject(new Error('CLOUD_CONTAINER_UNAVAILABLE'))
	if (!container.env || !container.serviceName || /^YOUR_/i.test(container.serviceName)) {
		return Promise.reject(new Error('CLOUD_HOSTING_CONFIG_MISSING'))
	}

	const method = options.method || (options.data ? 'POST' : 'GET')
	const header = Object.assign({
		'Content-Type': 'application/json',
		'X-WX-SERVICE': container.serviceName
	}, options.header || {})
	if (options.requestId) header['X-Bobbo-Request-Id'] = String(options.requestId)
	if (options.syncSource) header['X-Bobbo-Sync-Source'] = String(options.syncSource)
	if (authState.sessionToken) header['X-Cat-Session'] = authState.sessionToken

	return new Promise((resolve, reject) => {
		let settled = false
		const succeed = (response) => {
			if (settled) return
			settled = true
			const statusCode = Number(response && response.statusCode)
			if (statusCode >= 200 && statusCode < 300) invalidateMutationCache(path, method, api)
			handleResponse(response, resolve, reject, api)
		}
		const fail = (error) => {
			if (settled) return
			settled = true
			reject(new Error((error && (error.errMsg || error.message)) || 'BACKEND_NETWORK_FAILED'))
		}
		try {
			const result = cloud.callContainer({
				config: { env: container.env },
				path: buildPath(path, options.query),
				method,
				data: options.data || {},
				header,
				success: succeed,
				fail
			})
			if (result && typeof result.then === 'function') result.then(succeed).catch(fail)
		} catch (error) {
			fail(error)
		}
	})
}

function callHttpBackend(path, options, api, runtime, authState) {
	if (!api || typeof api.request !== 'function') return Promise.reject(new Error('uni.request unavailable'))
	const method = options.method || (options.data ? 'POST' : 'GET')
	const header = Object.assign({
		'Content-Type': 'application/json'
	}, options.header || {})
	if (options.requestId) header['X-Bobbo-Request-Id'] = String(options.requestId)
	if (options.syncSource) header['X-Bobbo-Sync-Source'] = String(options.syncSource)
	if (authState.sessionToken) {
		header['X-Cat-Session'] = authState.sessionToken
	}

	return new Promise((resolve, reject) => {
		const requestUrl = buildUrl(path, options.query, api, runtime, options.wxApi)
		api.request({
			url: requestUrl,
			method,
			data: options.data || {},
			header,
			success: (response) => {
				const statusCode = Number(response && response.statusCode)
				if (statusCode >= 200 && statusCode < 300) invalidateMutationCache(path, method, api)
				handleResponse(response, resolve, reject, api)
			},
			fail: (error) => {
				const failure = new Error((error && (error.errMsg || error.message)) || 'BACKEND_NETWORK_FAILED')
				failure.code = 'BACKEND_NETWORK_FAILED'
				failure.errMsg = String((error && error.errMsg) || '')
				failure.url = requestUrl
				reject(failure)
			}
		})
	})
}

function performBackendRequest(path, options, api, runtime, authState) {
	if (isCloudHosting(runtime)) return callCloudContainer(path, options, api, runtime, authState)
	return callHttpBackend(path, options, api, runtime, authState)
}

function redirectToLogin(api) {
	clearAppSession(api)
	if (api && typeof api.reLaunch === 'function') api.reLaunch({ url: '/pages/login/index' })
}

function renewBackendSession(api, runtime, options) {
	if (sessionRenewalPromise) return sessionRenewalPromise
	const profile = readAppAuthState(api).profile || {}
	const loginOptions = {
		method: 'POST',
		data: {
			nickname: profile.nickname || '',
			avatar: profile.avatar || ''
		},
		backendRuntime: runtime,
		wxApi: options.wxApi
	}
	sessionRenewalPromise = performBackendRequest(
		'/api/auth/wechat-login',
		loginOptions,
		api,
		runtime,
		{ sessionToken: '' }
	).then((payload) => {
		if (!payload || !payload.sessionToken) throw new Error('SESSION_RENEWAL_INVALID')
		saveAppSession({
			sessionToken: payload.sessionToken,
			user: payload.user || profile
		}, api)
		return payload.sessionToken
	}).finally(() => {
		sessionRenewalPromise = null
	})
	return sessionRenewalPromise
}

function refreshBackendSession(options = {}, uniApi) {
	const api = getUni(uniApi)
	const runtime = options.backendRuntime || BACKEND_RUNTIME
	return renewBackendSession(api, runtime, options)
}

async function callBackend(path, options = {}, uniApi) {
	const api = getUni(uniApi)
	const runtime = options.backendRuntime || BACKEND_RUNTIME
	const authState = readAppAuthState(api)
	try {
		return await performBackendRequest(path, options, api, runtime, authState)
	} catch (error) {
		if (Number(error && error.statusCode) !== 401 || String(path) === '/api/auth/wechat-login') throw error
	}

	try {
		const latestAuthState = readAppAuthState(api)
		if (!latestAuthState.sessionToken || latestAuthState.sessionToken === authState.sessionToken) {
			await renewBackendSession(api, runtime, options)
		}
		return await performBackendRequest(path, options, api, runtime, readAppAuthState(api))
	} catch (error) {
		redirectToLogin(api)
		throw error
	}
}

module.exports = {
	buildUrl,
	callBackend,
	getRequestBaseUrl,
	getBackendErrorMessage,
	refreshBackendSession,
	toBackendError
}
