const CLOUD_ENV_ID = ''
const CLOUD_HOSTING_ENV_ID = 'YOUR_CLOUDBASE_ENV'
const ACTIVE_BACKEND_TUNNEL_BASE_URL = 'https://api.example.com'
const LEGACY_BACKEND_BASE_URLS = Object.freeze([
	'http://172.20.10.3:8000',
	'https://bobbo-mini-api.nport.link',
	'https://api.example.com',
	'https://reel-significantly-darwin-gba.trycloudflare.com',
	'https://maple-reform-benjamin-metro.trycloudflare.com',
	'https://unix-janet-voice-smilies.trycloudflare.com',
	'https://de51b7094a4f18.lhr.life'
])

const BACKEND_RUNTIME = Object.freeze({
	mode: 'local',
	// All self-hosted builds currently enter the Aliyun ECS backend through this server-side tunnel.
	localBaseUrl: ACTIVE_BACKEND_TUNNEL_BASE_URL,
	developmentBaseUrl: ACTIVE_BACKEND_TUNNEL_BASE_URL,
	trialBaseUrl: ACTIVE_BACKEND_TUNNEL_BASE_URL,
	cloud: Object.freeze({
		envId: CLOUD_HOSTING_ENV_ID,
		serviceName: 'cat-feeding-api',
		// HLS and MP4 must use the deployed service's public HTTPS domain.
		publicBaseUrl: 'https://api.example.com'
	})
})

function normalizeBaseUrl(value) {
	return String(value || '').trim().replace(/\/+$/, '')
}

function isCloudHosting(runtime = BACKEND_RUNTIME) {
	return runtime && runtime.mode === 'cloud-hosting'
}

function getBackendBaseUrl(runtime = BACKEND_RUNTIME) {
	const source = isCloudHosting(runtime) ? runtime.cloud && runtime.cloud.publicBaseUrl : runtime && runtime.localBaseUrl
	return normalizeBaseUrl(source)
}

function getCloudContainerOptions(runtime = BACKEND_RUNTIME) {
	const cloud = runtime && runtime.cloud ? runtime.cloud : {}
	return {
		env: String(cloud.envId || '').trim(),
		serviceName: String(cloud.serviceName || '').trim()
	}
}

module.exports = {
	ACTIVE_BACKEND_TUNNEL_BASE_URL,
	BACKEND_RUNTIME,
	CLOUD_ENV_ID,
	CLOUD_HOSTING_ENV_ID,
	LEGACY_BACKEND_BASE_URLS,
	getBackendBaseUrl,
	getCloudContainerOptions,
	isCloudHosting,
	normalizeBaseUrl
}
