<template>
	<view class="qr-page">
		<bobbo-nav-bar title="二维码配置" title-align="left"></bobbo-nav-bar>
		<view class="page-content">
		<view class="header">
			<text class="desc">填好 WiFi 信息后生成二维码，让摄像头扫码完成配网。</text>
		</view>

		<view class="form-card" v-if="!qrCodeImg">
			<input class="input-field" v-model="wifiName" placeholder="WiFi 名称（仅支持 2.4G）" />
			<input class="input-field" v-model="wifiPassword" placeholder="WiFi 密码" password />
			<button class="btn-primary" @click="getQRCode" :disabled="!wifiName || generating">
				{{ generating ? '生成中...' : '生成二维码' }}
			</button>
			<text class="hint" v-if="!wifiName">连接 WiFi 后可尝试自动填入名称</text>
			<text class="debug-log" v-if="debugLog">{{debugLog}}</text>
		</view>

		<canvas class="hidden-canvas" canvas-id="qrcode-canvas" />
		<view class="qr-stage" v-if="qrCodeImg">
			<view class="qr-frame">
				<image class="qr-img" :src="qrCodeImg" mode="aspectFit" />
			</view>
			<view class="status-line">
				<text class="status-text" v-if="!isPairingSuccess">请将摄像头对准二维码...</text>
				<text class="status-text success" v-else>配网成功</text>
			</view>
			<button class="btn-secondary" v-if="!isPairingSuccess" @click="regenerate">重新生成</button>
			<button class="btn-primary" v-if="isPairingSuccess" @click="goDevice">返回设备列表</button>
		</view>
		</view>
	</view>
</template>

<script>
	import uQRCode from '@/common/uqrcode.js'
	import hotspot from '@/utils/hotspot.js'
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend } = require('@/utils/backendClient.js')
	const { upsertOwnedDevice } = require('@/utils/ownedDeviceCache.js')
	const { buildDeviceBindDraft } = require('@/utils/pendingDeviceBind.js')

	export default {
		data() {
			return {
				wifiName: '',
				wifiPassword: '',
				ipNum: '0',
				randnum: '',
				qrCodeImg: '',
				macAddress: '02:00:00:00:00:00',
				isPairingSuccess: false,
				generating: false,
				_polling: false,
				debugLog: ''
			}
		},
		onLoad() {
			this.makeRandom()
			// #ifdef MP-WEIXIN
			this.getIP()
			this.getMacAddress()
			// #endif
		},
		onUnload() {
			this._polling = false
		},
		methods: {
			logMsg(msg) {
				this.debugLog = msg
				console.log('[bind-qrcode]', msg)
			},
			ensureAppAuth() {
				return !!ensureAppSession({ message: '请先登录' })
			},
			makeRandom() {
				const pool = '0123456789abcd'
				let code = ''
				for (let i = 0; i < 10; i++) code += pool[Math.floor(Math.random() * pool.length)]
				this.randnum = code
			},
			getIP() {
				wx.getLocalIPAddress({
					success: (res) => {
						const idx = res.localip.lastIndexOf('.')
						this.ipNum = res.localip.substring(idx + 1)
					},
					fail: (e) => console.log('[bind-qrcode] getLocalIPAddress fail', e)
				})
			},
			getMacAddress() {
				hotspot.checkConnected()
					.then((wifi) => {
						if (!this.wifiName) this.wifiName = wifi.ssid || ''
						this.macAddress = wifi.bssid || this.macAddress
					})
					.catch((e) => console.log('[bind-qrcode] getConnectedWifi fail', e))
			},
			getQRCode() {
				if (!this.ensureAppAuth()) return
				if (!this.wifiName) {
					uni.showToast({ title: '请输入 WiFi 名称', icon: 'none' })
					return
				}
				this.generating = true
				this.logMsg('正在生成二维码...')
				const data = {
					wifiName: this.wifiName,
					wifiPwd: this.wifiPassword,
					ipNum: this.ipNum,
					Randnum: this.randnum
				}
				const url = this.JLWXSDK.getGenerateQRCodeContent(data)
				uQRCode.make({
					canvasId: 'qrcode-canvas',
					componentInstance: this,
					text: url,
					size: 220,
					margin: 16,
					backgroundColor: '#ffffff',
					foregroundColor: '#000000',
					fileType: 'jpg',
					errorCorrectLevel: uQRCode.errorCorrectLevel.L,
					success: (res) => {
						this.qrCodeImg = res
						this.generating = false
						this.logMsg('二维码已生成，等待摄像头扫码...')
						this._polling = true
						this.pollResult(data)
					},
					fail: (err) => {
						this.generating = false
						console.error('[bind-qrcode] uQRCode failed', err)
						this.logMsg('二维码生成失败')
						uni.showToast({ title: '二维码生成失败', icon: 'none' })
					}
				})
			},
			pollResult(data) {
				if (!this._polling) return
				this.JLWXSDK.getQrcodeResult(data, (res) => {
					if (!this._polling) return
					if (res && res.ret == 200) {
						this._polling = false
						this.isPairingSuccess = true
						this.logMsg('摄像头已配网，正在完成绑定...')
						this.bindDevice(res)
					} else {
						setTimeout(() => this.pollResult(data), 1500)
					}
				})
			},
			bindDevice(config) {
				if (!this.ensureAppAuth()) return
				const draft = buildDeviceBindDraft(config || {})
				const payload = {
					sn: draft.sn,
					username: draft.username || 'admin',
					password: draft.password || '',
					nickname: '布卜布卜摄像头',
					ip: draft.ip || '',
					port: draft.port || ''
				}
				if (draft.adminToken) payload.adminToken = draft.adminToken
				if (!payload.sn) {
					this.logMsg('未拿到设备 SN，无法绑定')
					uni.showToast({ title: '缺少设备 SN', icon: 'none' })
					return
				}
				callBackend('/api/devices', { method: 'POST', data: payload })
					.then((result) => {
						upsertOwnedDevice((result && result.device) || payload, uni)
						this.logMsg('绑定成功')
						uni.showToast({ title: '绑定成功', icon: 'success' })
						setTimeout(() => this.goDevice(), 1500)
					})
					.catch((err) => {
						console.log('[bind-qrcode] backend bind failed', err)
						this.logMsg('绑定失败：' + ((err && err.message) || '请稍后重试'))
						uni.showToast({ title: '绑定失败', icon: 'none' })
					})
			},
			regenerate() {
				this._polling = false
				this.qrCodeImg = ''
				this.makeRandom()
				this.logMsg('')
			},
			goDevice() {
				this._polling = false
				uni.reLaunch({ url: '/pages/device/index' })
			}
		}
	}
</script>

<style lang="scss" scoped>
	.qr-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.page-content { padding: 32rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); }
	.header { margin-bottom: 28rpx;
		.desc { display: block; font-size: 26rpx; color: #989893; line-height: 1.5; }
	}
	.form-card { background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 28rpx; }
	.input-field { display: block; box-sizing: border-box; width: 100%; height: 88rpx; line-height: 88rpx; background: #FFFFFF; border-radius: 14rpx; padding: 0 28rpx; margin-bottom: 20rpx; font-size: 30rpx; color: #141414; border: 2rpx solid #EDEDEB; }
	.btn-primary { min-height: 88rpx; box-sizing: border-box; background: #141414; color: #FFFFFF; border-radius: 16rpx; font-size: 30rpx; font-weight: 600; margin-top: 16rpx; }
	.btn-primary::after, .btn-secondary::after { border: none; }
	.btn-primary[disabled] { background: #C4C4C0; color: #FFFFFF; }
	.btn-secondary { min-height: 88rpx; box-sizing: border-box; background: #FFFFFF; color: #141414; border: 2rpx solid #E8E8E5; border-radius: 16rpx; font-size: 30rpx; margin-top: 24rpx; }
	.hint { display: block; margin-top: 8rpx; font-size: 22rpx; color: #989893; }
	.debug-log { display: block; margin-top: 24rpx; padding: 16rpx; background: #F1F1EF; border-radius: 12rpx; font-size: 22rpx; color: #5A5A56; word-break: break-all; }
	.qr-stage { display: flex; flex-direction: column; align-items: center; padding-top: 32rpx; }
	.qr-frame { width: 480rpx; height: 480rpx; box-sizing: border-box; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 24rpx; display: flex; align-items: center; justify-content: center; }
	.qr-img { width: 100%; height: 100%; }
	.status-line { margin-top: 32rpx; }
	.status-text { font-size: 28rpx; color: #5A5A56; }
	.status-text.success { color: #2FA35C; font-weight: 600; }
	.hidden-canvas { position: absolute; left: -9999rpx; top: -9999rpx; width: 220rpx; height: 220rpx; }
</style>
