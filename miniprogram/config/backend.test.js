const test = require('node:test')
const assert = require('node:assert/strict')

const {
	ACTIVE_BACKEND_TUNNEL_BASE_URL,
	BACKEND_RUNTIME,
	CLOUD_ENV_ID,
	CLOUD_HOSTING_ENV_ID,
	LEGACY_BACKEND_BASE_URLS,
	getBackendBaseUrl,
	getCloudContainerOptions,
	isCloudHosting
} = require('./backend.js')

test('self-hosted builds use the active server-side tunnel', () => {
	assert.equal(CLOUD_ENV_ID, '')
	assert.equal(CLOUD_HOSTING_ENV_ID, 'YOUR_CLOUDBASE_ENV')
	assert.equal(isCloudHosting(BACKEND_RUNTIME), false)
	assert.equal(ACTIVE_BACKEND_TUNNEL_BASE_URL, 'https://api.example.com')
	assert.equal(getBackendBaseUrl(BACKEND_RUNTIME), ACTIVE_BACKEND_TUNNEL_BASE_URL)
	assert.equal(BACKEND_RUNTIME.developmentBaseUrl, ACTIVE_BACKEND_TUNNEL_BASE_URL)
	assert.equal(BACKEND_RUNTIME.trialBaseUrl, ACTIVE_BACKEND_TUNNEL_BASE_URL)
	assert.notEqual(BACKEND_RUNTIME.trialBaseUrl, 'https://api.example.com')
	assert.deepEqual(LEGACY_BACKEND_BASE_URLS, [
		'http://172.20.10.3:8000',
		'https://bobbo-mini-api.nport.link',
		'https://api.example.com',
		'https://reel-significantly-darwin-gba.trycloudflare.com',
		'https://maple-reform-benjamin-metro.trycloudflare.com',
		'https://unix-janet-voice-smilies.trycloudflare.com',
		'https://de51b7094a4f18.lhr.life'
	])
	assert.deepEqual(getCloudContainerOptions(BACKEND_RUNTIME), {
		env: 'YOUR_CLOUDBASE_ENV',
		serviceName: 'cat-feeding-api'
	})
})

test('cloud hosting configuration separates callContainer identity from public media routing', () => {
	const runtime = {
		...BACKEND_RUNTIME,
		mode: 'cloud-hosting',
		cloud: {
			...BACKEND_RUNTIME.cloud,
			envId: 'cloud1-prod',
			serviceName: 'cat-camera-api',
			publicBaseUrl: 'https://cat-camera.example.com/'
		}
	}

	assert.equal(isCloudHosting(runtime), true)
	assert.equal(getBackendBaseUrl(runtime), 'https://cat-camera.example.com')
	assert.deepEqual(getCloudContainerOptions(runtime), {
		env: 'cloud1-prod',
		serviceName: 'cat-camera-api'
	})
})
