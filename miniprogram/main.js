import App from './App'
import Vue from 'vue'

const jlinkWxSdk = require('./jlink-wx-sdk/dist/jlink-wx-sdk.js')
const { initCloudRuntime } = require('./utils/cloudRuntime.js')
const { CLOUD_ENV_ID } = require('./config/backend.js')

const sdkData = {
	uuid: 'YOUR_VENDOR_UUID',
	appKey: 'YOUR_VENDOR_APPKEY',
	appSecret: 'YOUR_VENDOR_APPSECRET',
	movedCard: 3
}
const JLWXSDK = new jlinkWxSdk.Api(sdkData)
console.log('jlinkWxSdk loaded', JLWXSDK)
Vue.prototype.JLWXSDK = JLWXSDK

Vue.prototype.CLOUD_ENV_ID = CLOUD_ENV_ID
Vue.prototype.CLOUD_READY = false

// #ifdef MP-WEIXIN
const cloudRuntime = initCloudRuntime({
	wxApi: typeof wx !== 'undefined' ? wx : null,
	cloudEnvId: CLOUD_ENV_ID,
	logger: console
})
Vue.prototype.CLOUD_READY = cloudRuntime.cloudReady
// #endif

Vue.config.productionTip = false
App.mpType = 'app'
const app = new Vue({ ...App })
app.$mount()
