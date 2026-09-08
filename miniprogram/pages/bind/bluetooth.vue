<template>
	<view class="ble-page">
		<bobbo-nav-bar title="蓝牙配网" title-align="left"></bobbo-nav-bar>
		<view class="page-content">
		<view class="page-header">
			<text class="page-desc">搜索新设备，也会继续绑定已连上 WiFi 的设备</text>
		</view>

		<view class="form-card">
			<view class="form-row">
				<text class="form-label">WiFi 名称</text>
				<input class="form-input" v-model="wifiName" placeholder="仅支持 2.4G WiFi" />
			</view>
			<view class="form-divider"></view>
			<view class="form-row">
				<text class="form-label">WiFi 密码</text>
				<input class="form-input" v-model="wifiPassword" placeholder="WiFi 密码" :password="!showPwd" />
				<view class="pwd-toggle" @click="showPwd = !showPwd">
					<cat-icon :name="showPwd ? 'check' : 'info'" :size="32" color="#989893" />
				</view>
			</view>
		</view>

		<view class="tip-card">
			<cat-icon name="info" :size="36" color="#989893" />
			<view class="tip-text">
				<text class="tip-title">配网前请确认</text>
				<text class="tip-line">1. 新设备处于配对模式，或已连上当前 WiFi</text>
				<text class="tip-line">2. 手机已开启蓝牙、定位和本地网络权限</text>
				<text class="tip-line">3. WiFi 是 2.4G 频段</text>
			</view>
		</view>

		<view class="primary-btn" :class="{disabled: searching}" @click="searchBleDevice">
			<cat-icon v-if="!searching" name="wifi" :size="36" color="#FFFFFF" />
			<text class="primary-btn-text">{{searching ? '搜索中...' : '搜索/添加设备'}}</text>
		</view>

		<view class="status-line" v-if="statusText">
			<text class="status-text">{{statusText}}</text>
		</view>

		<view class="manual-card" v-if="showManualBind">
			<text class="manual-title">已经连上 WiFi 但搜不到？</text>
			<text class="manual-desc">输入机身或包装上的 SN，继续在这里添加。</text>
			<view class="manual-row">
				<input class="manual-input" v-model="manualSn" placeholder="设备 SN" />
				<view class="manual-btn" :class="{disabled: bindingActive}" @click="bindManualDevice">
					<text class="manual-btn-text">添加</text>
				</view>
			</view>
		</view>
		</view>

		<view class="popup-mask" v-if="showPopup" @click="closePopup">
			<view class="popup-card" @click.stop>
				<view class="popup-header">
					<text class="popup-title">附近的设备</text>
					<text class="popup-count">已发现 {{foundCount}} 台</text>
					<view class="popup-close" @click="closePopup">
						<text class="close-icon">×</text>
					</view>
				</view>
				<scroll-view class="popup-list" scroll-y>
					<view class="ble-item" v-for="(item, index) in bluetoothList" :key="index" @click="bindConnectBluetooth(item)">
						<view class="ble-icon"><cat-icon name="camera" :size="44" color="#141414" /></view>
						<view class="ble-info">
							<text class="ble-name">{{item.deviceName || item.name || '未知设备'}}</text>
							<text class="ble-pid">{{item.pid ? 'PID: ' + item.pid : item.deviceId}}</text>
						</view>
						<text class="ble-action">配网</text>
					</view>
					<view class="ble-empty" v-if="bluetoothList.length === 0">
						<text class="ble-empty-text">正在搜索...</text>
					</view>
				</scroll-view>
			</view>
		</view>
	</view>
</template>

<script>
	const { decodeDeviceIpHex } = require('@/utils/deviceIp.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend } = require('@/utils/backendClient.js')
	const { readOwnedDevices, upsertOwnedDevice } = require('@/utils/ownedDeviceCache.js')
	const {
		buildDeviceBindDraft,
		clearPendingDeviceBind,
		readPendingDeviceBind,
		savePendingDeviceBind
	} = require('@/utils/pendingDeviceBind.js')
	import hotspot from '@/utils/hotspot.js'
	import catIcon from '@/components/cat-icon/cat-icon.vue'

	const SCAN_TIMEOUT_MS = 15000
	const BINDING_TIMEOUT_MS = 20000

	export default {
		components: { catIcon },
		data() {
			return {
				wifiName: '',
				wifiPassword: '',
				ipAddress: '',
				macAddress: '',
				showPwd: false,
				searching: false,
				bindingActive: false,
				statusText: '',
				bluetoothList: [],
				hasFound: {},
				deviceId: '',
				showPopup: false,
				scanTimer: null,
				bindingTimer: null,
				foundCount: 0,
				pairingConfig: null,
				manualSn: '',
				showManualBind: false,
				lastError: ''
			}
		},
		onLoad() {
			this.loadLocalWifiInfo()
		},
		onUnload() {
			this.clearScanTimer()
			this.clearBindingTimer()
			this.resetBluetoothSession('page-unload')
		},
		methods: {
			logDebug(step, payload) {
				if (payload !== undefined) console.log(`[BLE-DEBUG] ${step}`, payload)
				else console.log(`[BLE-DEBUG] ${step}`)
			},
			setStatus(text, error = '') {
				this.statusText = text
				this.lastError = error
			},
			ensureAppAuth() {
				return !!ensureAppSession({ message: '请先登录' })
			},
			clearScanTimer() {
				if (this.scanTimer) {
					clearTimeout(this.scanTimer)
					this.scanTimer = null
				}
			},
			clearBindingTimer() {
				if (this.bindingTimer) {
					clearTimeout(this.bindingTimer)
					this.bindingTimer = null
				}
			},
			startScanTimeout() {
				this.clearScanTimer()
				this.scanTimer = setTimeout(() => {
					if (!this.searching || this.foundCount > 0) return
					this.showPopup = false
					this.searching = false
					this.showManualBind = true
					this.setStatus('没有发现可添加设备。若设备已连上 WiFi，可稍后重试或输入 SN 手动绑定。', 'scan-timeout')
					this.resetBluetoothSession('timeout')
				}, SCAN_TIMEOUT_MS)
			},
			startBindingTimeout(data) {
				this.clearBindingTimer()
				this.bindingTimer = setTimeout(() => {
					this.setStatus('绑定请求超过 20 秒未返回，请确认手机和电脑在同一网络后重试', 'binding-timeout')
					this.logDebug('binding timeout', data)
				}, BINDING_TIMEOUT_MS)
			},
			loadLocalWifiInfo() {
				// #ifdef MP-WEIXIN
				if (typeof wx !== 'undefined' && wx.getLocalIPAddress) {
					wx.getLocalIPAddress({
						success: (res) => {
							this.ipAddress = res.localip || this.ipAddress
						},
						fail: (err) => this.logDebug('get local ip failed', err)
					})
				}
				if (typeof wx !== 'undefined') {
					hotspot.checkConnected()
						.then((wifi) => {
							if (!this.wifiName) this.wifiName = wifi.ssid || ''
							this.macAddress = wifi.bssid || this.macAddress
						})
						.catch((err) => this.logDebug('get connected wifi failed', err))
				}
				// #endif
			},
			searchBleDevice() {
				if (this.searching) return
				if (!this.ensureAppAuth()) return
				if (!this.wifiName) {
					uni.showToast({ title: '请输入 WiFi 名称', icon: 'none' })
					return
				}
				this.bluetoothList = []
				this.hasFound = {}
				this.foundCount = 0
				this.pairingConfig = null
				this.showPopup = false
				this.showManualBind = false
				this.searching = true
				this.setStatus('正在查找可添加的设备...')
				if (!this.wifiPassword) {
					this.tryBindPendingDevice()
					this.startConfiguredDeviceDiscovery()
					this.setStatus('正在查找已连上 WiFi 的设备；如需重新配网，请输入 WiFi 密码。')
					this.startScanTimeout()
					return
				}
				clearPendingDeviceBind()
				this.resetBluetoothSession('before-scan').then(() => {
					if (this.searching) this.openBluetoothAdapter()
				})
			},
			tryBindPendingDevice() {
				const pending = readPendingDeviceBind()
				if (!pending) return false
				this.logDebug('pending configured device found', { sn: pending.sn, ip: pending.ip })
				this.setStatus('发现上次已配网的设备，正在继续绑定...')
				this.bindDevice(pending, { source: 'pending', savePending: false })
				return true
			},
			startConfiguredDeviceDiscovery() {
				if (!this.JLWXSDK || typeof this.JLWXSDK.udpSendMulticastData !== 'function') return
				const data = {
					wifiName: this.wifiName,
					wifiPwd: this.wifiPassword || '',
					macAddress: this.macAddress || '02:00:00:00:00:00',
					ipAddress: this.ipAddress || ''
				}
				this.logDebug('configured device discovery started', {
					wifiName: data.wifiName,
					macAddress: data.macAddress,
					ipAddress: data.ipAddress
				})
				try {
					this.JLWXSDK.udpSendMulticastData(data, (result) => {
						this.logDebug('configured device discovery result', result)
						const config = Object.assign({}, result || {})
						if (config.devIp) {
							try {
								config.devIp = decodeDeviceIpHex(config.devIp)
							} catch (err) {
								this.logDebug('configured devIp parse failed', { devIp: config.devIp, err })
							}
						}
						const draft = buildDeviceBindDraft(config)
						if (!draft.sn) return
						this.setStatus('发现已连上 WiFi 的设备，正在绑定...')
						this.bindDevice(config, { source: 'configured-discovery' })
					})
				} catch (err) {
					this.logDebug('configured device discovery failed', err)
				}
			},
			openBluetoothAdapter() {
				uni.openBluetoothAdapter({
					success: () => {
						this.setStatus('蓝牙已开启，正在扫描附近设备')
						this.startBluetoothDevicesDiscovery()
					},
					fail: (err) => {
						this.searching = false
						this.showManualBind = true
						this.setStatus('蓝牙初始化失败，请检查蓝牙和定位权限', JSON.stringify(err))
						uni.showToast({ title: '请开启蓝牙', icon: 'none' })
					}
				})
			},
			startBluetoothDevicesDiscovery() {
				try {
					this.JLWXSDK.startDevicesDiscovery({
						success: () => {
							this.setStatus('正在扫描附近设备')
						},
						onDeviceFound: (device) => {
							const foundKey = device.deviceId || `${device.deviceName || device.name || 'unknown'}-${device.pid || ''}`
							if (!this.hasFound[foundKey]) {
								this.hasFound[foundKey] = device
								this.bluetoothList = this.bluetoothList.concat(device)
								this.foundCount = this.bluetoothList.length
							}
							this.clearScanTimer()
							this.setStatus(`已发现 ${this.foundCount} 台设备，请选择要配置的设备`)
							this.showPopup = this.bluetoothList.length > 0
						},
						fail: (err, detail) => {
							const failPayload = detail || err
							this.clearScanTimer()
							this.searching = false
							this.showPopup = false
							this.showManualBind = true
							this.setStatus('启动扫描失败，请重试', JSON.stringify(failPayload || err))
						}
					})
					if (this.searching) this.startScanTimeout()
				} catch (err) {
					this.clearScanTimer()
					this.searching = false
					this.showPopup = false
					this.showManualBind = true
					this.setStatus('启动扫描异常，请重试', JSON.stringify(err))
				}
			},
			bindConnectBluetooth(item) {
				this.stopBluetoothDevicesDiscovery('device-selected')
				this.showPopup = false
				this.deviceId = item.deviceId
				uni.showLoading({ title: '配网中...' })
				this.setStatus('正在连接设备并下发 WiFi')
				this.JLWXSDK.createBLEConnection({
					deviceId: item.deviceId,
					name: this.wifiName,
					pwd: this.wifiPassword,
					write: (res) => this.logDebug('pairing write chunk', res),
					success: (res) => {
						uni.hideLoading()
						const config = Object.assign({}, res)
						if (config.devIp) {
							try {
								config.devIp = decodeDeviceIpHex(config.devIp)
							} catch (err) {
								this.logDebug('devIp parse failed', { devIp: config.devIp, err })
							}
						}
						this.pairingConfig = config
						savePendingDeviceBind(config)
						this.setStatus('设备配网成功，正在完成绑定')
						this.bindDevice(config, { source: 'ble-pairing' })
						this.cleanupBluetoothAfterPairing('pairing-success')
					},
					fail: (err) => {
						uni.hideLoading()
						const errCode = err && typeof err === 'object' ? (err.code || err.errCode) : err
						const errMap = { 51: '未找到 WiFi 热点', 52: 'WiFi 握手失败', 53: 'WiFi 密码错误', 54: '数据解析异常', 55: '配网失败' }
						const tip = errMap[errCode] || '配网失败，请重试'
						this.setStatus(tip, String(errCode || 'pairing-failed'))
						uni.showToast({ title: tip, icon: 'none' })
						this.cleanupBluetoothAfterPairing('pairing-failed')
					}
				})
			},
			bindDevice(config, options = {}) {
				if (this.bindingActive) return
				const draft = buildDeviceBindDraft(config || {})
				const payload = {
					sn: draft.sn,
					username: draft.username || 'admin',
					password: draft.password || '',
					nickname: draft.nickname || '猫饭摄像头',
					ip: draft.ip || '',
					port: draft.port || ''
				}
				if (draft.adminToken) payload.adminToken = draft.adminToken
				if (!payload.sn) {
					this.setStatus('没有可绑定的设备序列号，请重新配网', 'missing-device-no')
					uni.showToast({ title: '缺少设备 SN', icon: 'none' })
					return
				}
				if (options.savePending !== false) savePendingDeviceBind(config || payload)
				this.bindingActive = true
				const requestId = 'bind_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10)
				this.setStatus('正在绑定设备')
				this.startBindingTimeout(payload)
				callBackend('/api/devices', {
					method: 'POST',
					data: payload,
					requestId,
					syncSource: options.source || 'bluetooth'
				})
					.then((result) => {
						this.completeDeviceBinding((result && result.device) || payload)
					})
					.catch((err) => {
						this.clearBindingTimer()
						console.log('[bluetooth] backend bind failed', err)
						return this.recoverExistingOwnedDevice(payload).then((existing) => {
							if (existing) {
								this.logDebug('existing owned device recovered after bind failure', { sn: payload.sn })
								this.completeDeviceBinding(existing, '设备已在当前账号，配网已更新', '设备已绑定')
								return
							}
							const diagnosticId = String((err && err.requestId) || requestId)
							this.setStatus('设备已联网，但账号同步失败：' + this.formatBindError(err) + '（诊断编号 ' + diagnosticId + '）', 'bind-failed')
							uni.showToast({ title: '账号同步失败', icon: 'none' })
						})
					})
					.finally(() => {
						this.bindingActive = false
					})
			},
			completeDeviceBinding(device, statusText = '设备绑定成功', toastText = '设备绑定成功') {
				upsertOwnedDevice(device, uni)
				this.clearBindingTimer()
				clearPendingDeviceBind()
				this.searching = false
				this.setStatus(statusText)
				uni.showToast({ title: toastText, icon: 'success', duration: 1500 })
				setTimeout(() => uni.navigateBack({ delta: 2 }), 1500)
			},
			recoverExistingOwnedDevice(payload) {
				const sn = String(payload && payload.sn || '').trim()
				const cached = readOwnedDevices(uni).find((device) => device.sn === sn)
				if (cached) return Promise.resolve(Object.assign({}, cached, payload))
				return callBackend('/api/devices')
					.then((result) => {
						const devices = result && Array.isArray(result.devices) ? result.devices : []
						return devices.find((device) => String(device && device.sn || '').trim() === sn) || null
					})
					.catch((error) => {
						this.logDebug('owned device recovery check failed', error)
						return null
					})
			},
			formatBindError(err) {
				const message = (err && err.message) || '请稍后重试'
				if (message.indexOf('29013') >= 0 || message.indexOf('DEV_SUPPORT_TOKEN_ONLY_ONE_ACCOUNT_ADD') >= 0) {
					return '设备已被其他账号添加，或缺少配网凭证。请先在原账号解绑，或长按设备重置后重新添加。'
				}
				if (message.indexOf('JF_CONFIG_MISSING') >= 0) {
					return '设备服务配置缺失，请联系管理员'
				}
				return message
			},
			bindManualDevice() {
				if (!this.ensureAppAuth()) return
				if (this.bindingActive) return
				const sn = String(this.manualSn || '').trim()
				if (!sn) {
					uni.showToast({ title: '请输入设备 SN', icon: 'none' })
					return
				}
				this.setStatus('正在按 SN 添加设备')
				this.bindDevice({ deviceNo: sn, userName: 'admin', password: '', nickname: '猫饭摄像头' }, { source: 'manual-inline' })
			},
			stopBluetoothDevicesDiscovery(reason = 'manual-stop') {
				this.searching = false
				this.clearScanTimer()
				this.logDebug(`stop discovery requested (${reason})`)
				this.JLWXSDK.stopBluetoothDevicesDiscovery({
					success: (res) => this.logDebug('discovery stopped', res),
					fail: (err) => this.logDebug('stop discovery failed', err)
				})
			},
			callWxBluetooth(method, payload = {}, reason = 'manual') {
				return new Promise((resolve) => {
					if (typeof wx === 'undefined' || !wx[method]) {
						resolve({ skipped: true })
						return
					}
					wx[method](Object.assign({}, payload, {
						success: (res) => resolve({ ok: true, res }),
						fail: (err) => resolve({ ok: false, err })
					}))
				})
			},
			async closeBLEConnection(reason = 'manual-stop') {
				if (!this.deviceId) return
				const deviceId = this.deviceId
				await this.callWxBluetooth('closeBLEConnection', { deviceId }, reason)
				if (this.deviceId === deviceId) this.deviceId = ''
			},
			async resetBluetoothSession(reason = 'manual-reset') {
				await this.callWxBluetooth('stopBluetoothDevicesDiscovery', {}, reason)
				await this.closeBLEConnection(reason)
				await this.callWxBluetooth('closeBluetoothAdapter', {}, reason)
			},
			cleanupBluetoothAfterPairing(reason = 'pairing-finished') {
				this.searching = false
				this.clearScanTimer()
				this.closeBLEConnection(reason)
			},
			closePopup() {
				this.showPopup = false
			}
		}
	}
</script>

<style>
	.ble-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.page-content { padding: 32rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); }
	.page-header { padding: 4rpx 0 28rpx; }
	.page-desc { font-size: 26rpx; color: #989893; line-height: 1.5; }
	.form-card { background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 8rpx 28rpx; margin-bottom: 28rpx; }
	.form-row { display: flex; align-items: center; padding: 32rpx 0; }
	.form-label { font-size: 28rpx; font-weight: 600; color: #141414; width: 180rpx; flex-shrink: 0; }
	.form-input { flex: 1; min-width: 0; height: 72rpx; line-height: 72rpx; font-size: 28rpx; color: #141414; }
	.form-divider { height: 2rpx; background: #EFEFED; }
	.pwd-toggle { padding: 8rpx; }
	.tip-card { display: flex; gap: 16rpx; background: #F1F1EF; border-radius: 14rpx; padding: 24rpx; margin-bottom: 36rpx; }
	.tip-text { flex: 1; }
	.tip-title { display: block; font-size: 28rpx; font-weight: 700; color: #141414; margin-bottom: 8rpx; }
	.tip-line { display: block; font-size: 24rpx; color: #5A5A56; line-height: 1.7; }
	.primary-btn { display: flex; align-items: center; justify-content: center; gap: 12rpx; min-height: 88rpx; box-sizing: border-box; background: #141414; border-radius: 16rpx; padding: 24rpx 0; }
	.primary-btn.disabled { opacity: 0.6; }
	.primary-btn-text { font-size: 32rpx; color: #fff; font-weight: 600; }
	.status-line { text-align: center; margin-top: 32rpx; }
	.status-text { font-size: 26rpx; color: #5A5A56; }
	.manual-card { background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 28rpx; margin-top: 32rpx; }
	.manual-title { display: block; font-size: 28rpx; font-weight: 700; color: #141414; margin-bottom: 6rpx; }
	.manual-desc { display: block; font-size: 24rpx; color: #5A5A56; line-height: 1.6; margin-bottom: 20rpx; }
	.manual-row { display: flex; gap: 16rpx; align-items: center; }
	.manual-input { flex: 1; min-width: 0; height: 76rpx; line-height: 76rpx; background: #F1F1EF; border-radius: 14rpx; padding: 0 22rpx; font-size: 28rpx; color: #141414; box-sizing: border-box; }
	.manual-btn { width: 136rpx; height: 76rpx; border-radius: 14rpx; background: #141414; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.manual-btn.disabled { opacity: 0.55; }
	.manual-btn-text { font-size: 28rpx; font-weight: 600; color: #fff; }
	.popup-mask { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; z-index: 99; }
	.popup-card { width: 100%; max-height: 70vh; background: #FFFFFF; border-radius: 16rpx 16rpx 0 0; padding: 32rpx; padding-bottom: calc(32rpx + env(safe-area-inset-bottom)); box-sizing: border-box; }
	.popup-header { position: relative; padding-right: 72rpx; margin-bottom: 24rpx; }
	.popup-title { display: block; font-size: 34rpx; font-weight: 700; color: #141414; }
	.popup-count { display: block; margin-top: 6rpx; font-size: 24rpx; color: #989893; }
	.popup-close { position: absolute; top: 0; right: 0; width: 56rpx; height: 56rpx; border-radius: 50%; background: #F1F1EF; display: flex; align-items: center; justify-content: center; }
	.close-icon { font-size: 36rpx; color: #5A5A56; line-height: 1; }
	.popup-list { max-height: 52vh; }
	.ble-item { display: flex; align-items: center; padding: 24rpx 0; border-bottom: 2rpx solid #EFEFED; }
	.ble-icon { width: 72rpx; height: 72rpx; border-radius: 14rpx; background: #F1F1EF; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.ble-info { flex: 1; min-width: 0; margin-left: 20rpx; }
	.ble-name { display: block; font-size: 30rpx; font-weight: 600; color: #141414; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
	.ble-pid { display: block; margin-top: 4rpx; font-size: 22rpx; color: #989893; }
	.ble-action { font-size: 26rpx; font-weight: 600; color: #141414; }
	.ble-empty { padding: 80rpx 0; text-align: center; }
	.ble-empty-text { font-size: 26rpx; color: #989893; }
</style>
