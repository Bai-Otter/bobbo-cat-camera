<template>
	<view class="notification-page">
		<bobbo-nav-bar title="通知设置" title-align="left"></bobbo-nav-bar>
		<canvas class="hidden-canvas" canvas-id="clawbot-qrcode-canvas" :style="clawBotQrCanvasStyle" />

		<view class="notification-content">
			<view class="intro-copy">
				<text class="intro-label">连续进食提醒</text>
				<text class="intro-title">每台摄像头，只需开启一次</text>
				<text class="intro-text">完成一次微信提醒绑定后，服务器会发送进食开始和结束通知。自己的设备和家人分享的设备分别设置。</text>
			</view>

			<view class="binding-card">
				<view class="binding-heading">
					<view>
						<text class="binding-title">WxPusher 微信提醒</text>
						<text class="binding-copy">{{wxPusherBinding.deliveryReady ? '微信已连接，后续无需逐条授权' : '只需完成一次关注和账号绑定'}}</text>
					</view>
					<text class="binding-badge" :class="{active: wxPusherBinding.deliveryReady}">{{wxPusherBinding.deliveryReady ? '已连接' : '待绑定'}}</text>
				</view>
				<view v-if="!wxPusherBinding.deliveryReady && wxPusherBinding.qrImageUrl" class="binding-step">
					<text class="binding-step-index">01</text>
					<text class="binding-step-title">关注并绑定 WxPusher 微信提醒</text>
					<image class="binding-qr" :src="wxPusherBinding.qrImageUrl" mode="aspectFit" show-menu-by-longpress @click="previewWxPusherBindingQr"></image>
				</view>
				<text v-if="!wxPusherBinding.deliveryReady && wxPusherBinding.qrImageUrl" class="binding-tip">点击二维码进入大图，再长按选择“识别图中二维码”即可绑定；无需保存图片，微信会直接打开绑定页。</text>
				<button v-if="!wxPusherBinding.deliveryReady && wxPusherBinding.qrImageUrl" class="secondary-button qr-open-button" @click="previewWxPusherBindingQr">点开二维码直接识别</button>
				<button v-if="!wxPusherBinding.deliveryReady && wxPusherBinding.configured" class="primary-button" :loading="bindingLoading" :disabled="bindingLoading" @click="startWxPusherBinding">{{wxPusherBinding.qrImageUrl ? '刷新绑定状态' : '开始绑定微信提醒'}}</button>
				<button v-if="wxPusherBinding.deliveryReady" class="secondary-button binding-unbind" :disabled="bindingLoading" @click="removeWxPusherBinding">解除绑定</button>
				<text v-if="!wxPusherBinding.configured" class="binding-warning">微信提醒服务正在配置，请稍后刷新。</text>
			</view>

			<view v-if="wxPusherBinding.deliveryReady" class="clawbot-card">
				<view class="binding-heading">
					<view>
						<text class="binding-title">微信 ClawBot 直达</text>
						<text class="binding-copy">同一套 WxPusher 推送；ClawBot 是可选微信直达通道，不影响 App 通知。</text>
					</view>
					<text class="binding-badge" :class="{active: clawBot.status === 'active'}">{{clawBotBadge}}</text>
				</view>
				<text class="clawbot-state-copy">{{clawBotCopy}}</text>
				<view v-if="clawBot.status === 'active'" class="clawbot-meta">
					<text>有效期按 24 小时估算</text>
					<text>每个微信账号本轮最多约 10 条，所有设备共用</text>
				</view>
				<view v-else class="clawbot-activation">
					<text class="clawbot-entry-label">官方支持方式：在 WxPusher App 内绑定</text>
					<view v-if="clawBotQrImage" class="clawbot-qr-shell">
						<image class="clawbot-qr" :src="clawBotQrImage" mode="aspectFit" show-menu-by-longpress @click="previewClawBotQr"></image>
					</view>
					<view class="clawbot-steps">
						<text>1. 点击二维码，长按识别并安装 WxPusher App</text>
						<text>2. 用当前微信登录，打开“我的 → 推送渠道”</text>
						<text>3. 选择“绑定微信 ClawBot”，按 App 内动态引导完成</text>
					</view>
					<text class="clawbot-compatibility">如果微信仍显示“暂不支持浏览”，说明当前微信版本或账号尚不支持 ClawBot。小程序无法绕过微信资格限制；此时保留 WxPusher App 系统通知即可连续接收提醒。</text>
					<button class="secondary-button qr-open-button" @click="previewClawBotQr">打开 WxPusher 官方下载码</button>
					<button class="secondary-button qr-open-button" @click="copyClawBotAppUrl">复制官方下载链接</button>
					<button class="primary-button" :loading="clawBotLoading" :disabled="clawBotLoading || devices.length === 0" @click="verifyClawBot">{{clawBot.status === 'reactivation_required' ? '我已续期，发送测试' : '我已在 App 绑定，发送测试'}}</button>
					<text v-if="clawBotTestCopy" class="clawbot-test-copy">{{clawBotTestCopy}}</text>
				</view>
				<text class="clawbot-footnote">测试发出后，只有你明确确认在微信 ClawBot 对话中收到，才会标记为“直达已确认”；仅在 WxPusher App 收到时不会误标为 ClawBot。</text>
			</view>

			<view v-if="loadingDevices" class="state-card">
				<text class="state-title">正在读取设备</text>
				<text class="state-copy">请稍候</text>
			</view>
			<view v-else-if="devices.length === 0" class="state-card">
				<text class="state-title">还没有可用设备</text>
				<text class="state-copy">添加自己的摄像头，或让家人分享设备后再设置提醒。</text>
			</view>

			<view v-else class="device-section">
				<view v-for="device in devices" :key="device.sn" class="device-card">
					<view class="device-heading">
						<view class="device-copy">
							<text class="device-name">{{device.nickname || '食盆摄像头'}}</text>
							<text class="device-role">{{device.role === 'member' ? '家人分享给我的设备' : '我的设备'}}</text>
						</view>
						<switch
							:checked="persistentEnabled(device.sn)"
							:disabled="deviceState(device.sn).saving || !persistentAvailable(device.sn)"
							color="#141414"
							@change="togglePersistent(device, $event)"
						/>
					</view>

					<view class="device-status-row">
						<text class="status-dot" :class="{active: persistentEnabled(device.sn)}"></text>
						<text class="device-status">{{persistentStatus(device.sn)}}</text>
					</view>

					<view class="motion-setting-row">
						<view class="motion-setting-copy">
							<text class="motion-setting-title">小程序内显示移动记录</text>
							<text class="motion-setting-note">只控制小程序内是否显示；摄像头侦测与进食分析始终开启</text>
						</view>
						<switch
							:checked="motionAlertEnabled(device.sn)"
							:disabled="deviceState(device.sn).motionSaving"
							color="#141414"
							@change="toggleMotionAlerts(device, $event)"
						/>
					</view>

					<view v-if="deviceState(device.sn).longTerm.configured" class="template-row">
						<view v-for="item in deviceState(device.sn).longTerm.templates" :key="item.templateId" class="template-item">
							<text class="template-label">{{item.eventType === 'feeding_end' ? '结束进食' : '开始进食'}}</text>
							<text class="template-value" :class="{accepted: item.enabled}">{{templateStatusCopy(item)}}</text>
						</view>
					</view>

					<button
						v-if="deviceState(device.sn).longTerm.configured && !deviceState(device.sn).longTerm.enabled"
						class="primary-button"
						:disabled="deviceState(device.sn).saving"
						:loading="deviceState(device.sn).saving"
						@click="enableLongTerm(device)"
					>{{deviceState(device.sn).longTerm.partiallyEnabled ? '补全长期提醒' : '开启长期提醒'}}</button>

					<view v-if="trialBuild && persistentEnabled(device.sn)" class="test-actions">
						<button class="secondary-button" :disabled="deviceState(device.sn).testing" @click="sendTest(device, 'feeding_start')">测试开始提醒</button>
						<button class="secondary-button" :disabled="deviceState(device.sn).testing" @click="sendTest(device, 'feeding_end')">测试结束提醒</button>
					</view>
					<view v-if="deviceState(device.sn).testDelivery.status" class="delivery-band" :class="deviceState(device.sn).testDelivery.status">
						<text>{{deliveryCopy(deviceState(device.sn).testDelivery)}}</text>
					</view>

					<view v-if="!persistentAvailable(device.sn)" class="pending-band">
						<text class="pending-title">请先绑定消息通道</text>
						<text class="pending-copy">完成上方微信提醒绑定后，即可为这台设备持续开启提醒。</text>
					</view>

					<view v-if="!persistentEnabled(device.sn) && !wxPusherBinding.deliveryReady && deviceState(device.sn).fallback.configured" class="fallback-section">
						<text class="fallback-label">临时提醒</text>
						<view class="quota-row">
							<view class="quota-item">
								<text class="quota-label">开始进食</text>
								<text class="quota-value">剩余 {{fallbackCount(device.sn, 'feeding_start')}} 次</text>
							</view>
							<view class="quota-divider"></view>
							<view class="quota-item">
								<text class="quota-label">结束进食</text>
								<text class="quota-value">剩余 {{fallbackCount(device.sn, 'feeding_end')}} 次</text>
							</view>
						</view>
						<button class="fallback-button" :disabled="deviceState(device.sn).saving" @click="renewFallback(device)">临时领取下一次提醒</button>
						<text class="fallback-tip">仅在长期提醒尚未开启时使用；每次领取只覆盖下一次进食。</text>
					</view>
				</view>
			</view>

			<view v-if="devices.length > 0 && !longTermConfigured" class="review-card">
				<text class="review-label">后续可无缝升级</text>
				<text class="review-title">微信硬件消息仍在等待正式版资格</text>
				<text class="review-copy">体验阶段先使用当前连续提醒通道；微信硬件消息获批后会自动成为最高优先级，不会重复发送。</text>
			</view>

			<view class="explain-card">
				<text class="explain-title">为什么不需要每次领取</text>
				<text class="explain-copy">微信提醒账号只绑定一次；每台设备的开关可以单独调整。真实进食事件由服务器发送，并且同一事件只走一个通知通道。</text>
			</view>

			<view v-if="errorMessage" class="error-band"><text>{{errorMessage}}</text></view>
			<view class="bottom-safe"></view>
		</view>
	</view>
</template>

<script>
	import uQRCode from '@/common/uqrcode.js'
	const { buildUrl, callBackend } = require('@/utils/backendClient.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const {
		CLAWBOT_QR_MARGIN_PX,
		CLAWBOT_QR_SIZE_PX,
		clawBotQrCanvasStyle,
		normalizeWxPusherClawBot,
		wxPusherClawBotErrorCopy,
		wxPusherClawBotCopy
	} = require('@/utils/wxPusherClawBot.js')
	const {
		normalizeNotificationDelivery,
		notificationDeliveryCopy,
		waitForNotificationDelivery
	} = require('@/utils/notificationDelivery.js')
	const {
		normalizeDeviceSubscriptionResult,
		requestSubscribeDeviceMessage,
		subscriptionStatusCopy
	} = require('@/utils/wechatDeviceSubscriptions.js')
	const {
		normalizeSubscriptionResult,
		requestSubscriptionMessage
	} = require('@/utils/wechatSubscriptions.js')

	function emptyLongTerm() {
		return { configured: false, enabled: false, partiallyEnabled: false, templates: [] }
	}

	function emptyFallback() {
		return { configured: false, enabled: false, templates: [], totalRemaining: 0 }
	}

	export default {
		data() {
			return {
				devices: [],
				deviceStates: {},
				loadingDevices: false,
				longTermConfigured: false,
				trialBuild: false,
				bindingLoading: false,
				wxPusherBinding: {
					configured: false,
					bound: false,
					deliveryReady: false,
					provider: 'wxpusher',
					qrImageUrl: ''
				},
				clawBot: normalizeWxPusherClawBot(),
				clawBotQrImage: '',
				clawBotQrCanvasStyle: clawBotQrCanvasStyle(),
				clawBotLoading: false,
				clawBotTestDelivery: normalizeNotificationDelivery(),
				errorMessage: ''
			}
		},
		computed: {
			clawBotCopy() {
				return wxPusherClawBotCopy(this.clawBot)
			},
			clawBotBadge() {
				if (this.clawBot.status === 'active') return '直达已确认'
				if (this.clawBot.status === 'reactivation_required') return '需要续期'
				return '需在 App 绑定'
			},
			clawBotTestCopy() {
				if (!this.clawBotTestDelivery.id) return ''
				if (this.clawBotTestDelivery.status === 'delivered') return 'WxPusher 已接收，请到微信 ClawBot 对话确认'
				if (this.clawBotTestDelivery.status === 'failed') return '测试提醒投递失败，请重试'
				return '测试提醒正在投递到 WxPusher'
			}
		},
		onLoad() {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.trialBuild = this.resolveTrialBuild()
		},
		onShow() {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.loadDevices()
		},
		methods: {
			async loadWxPusherBinding() {
				try {
					const result = await callBackend('/api/notifications/wxpusher-binding')
					const binding = result.binding || {}
					this.wxPusherBinding = Object.assign({}, this.wxPusherBinding, binding, {
						provider: 'wxpusher',
						deliveryReady: !!binding.bound,
						qrImageUrl: binding.bound ? '' : this.wxPusherBinding.qrImageUrl
					})
					if (this.wxPusherBinding.deliveryReady) {
						await this.loadClawBotStatus()
					} else {
						this.clawBot = normalizeWxPusherClawBot()
						this.clawBotQrImage = ''
					}
					return this.wxPusherBinding
				} catch (error) {
					console.log('[notifications] wxpusher binding failed', error)
					return this.wxPusherBinding
				}
			},
			async loadClawBotStatus() {
				try {
					const response = await callBackend('/api/notifications/wxpusher-clawbot')
					this.clawBot = normalizeWxPusherClawBot(response.clawBot || {})
					if (this.clawBot.status !== 'active' && !this.clawBotQrImage) {
						this.$nextTick(() => this.generateClawBotQr())
					}
					return this.clawBot
				} catch (error) {
					console.log('[notifications] clawbot status failed', error)
					return this.clawBot
				}
			},
			generateClawBotQr() {
				if (!this.clawBot.activationUrl || this.clawBotQrImage) return
				uQRCode.make({
					canvasId: 'clawbot-qrcode-canvas',
					componentInstance: this,
					text: this.clawBot.activationUrl,
					size: CLAWBOT_QR_SIZE_PX,
					margin: CLAWBOT_QR_MARGIN_PX,
					backgroundColor: '#ffffff',
					foregroundColor: '#000000',
					fileType: 'png',
					errorCorrectLevel: uQRCode.errorCorrectLevel.M,
					success: (path) => { this.clawBotQrImage = path },
					fail: (error) => console.log('[notifications] clawbot qrcode failed', error)
				})
			},
			previewClawBotQr() {
				this.previewQrForRecognition(this.clawBotQrImage)
			},
			copyClawBotAppUrl() {
				const url = String(this.clawBot.activationUrl || '').trim()
				if (!url) return
				uni.setClipboardData({
					data: url,
					success: () => uni.showToast({ title: '官方下载链接已复制', icon: 'none' })
				})
			},
			previewWxPusherBindingQr() {
				this.previewQrForRecognition(this.wxPusherBinding.qrImageUrl)
			},
			previewQrForRecognition(imageUrl) {
				const image = String(imageUrl || '').trim()
				if (!image) {
					uni.showToast({ title: '二维码还在生成，请稍候', icon: 'none' })
					return
				}
				uni.previewImage({
					current: image,
					urls: [image],
					fail: () => uni.showToast({ title: '二维码打开失败，请重新生成', icon: 'none' })
				})
			},
			async verifyClawBot() {
				if (this.clawBotLoading) return
				const device = this.devices.find((item) => this.persistentEnabled(item.sn)) || this.devices[0]
				if (!device || !device.sn) {
					uni.showToast({ title: '还没有可用于测试的设备', icon: 'none' })
					return
				}
				this.clawBotLoading = true
				this.errorMessage = ''
				this.clawBotTestDelivery = normalizeNotificationDelivery()
				try {
					const response = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/notifications/test', {
						method: 'POST',
						data: { eventType: 'feeding_start' }
					})
					let delivery = normalizeNotificationDelivery(response.delivery || response)
					if (delivery.provider !== 'wxpusher' || !delivery.id) throw new Error('WXPUSHER_TEST_DELIVERY_REQUIRED')
					this.clawBotTestDelivery = delivery
					if (delivery.status === 'pending') {
						delivery = await waitForNotificationDelivery({
							deliveryId: delivery.id,
							loadDelivery: (deliveryId) => callBackend('/api/notifications/deliveries/' + encodeURIComponent(deliveryId)),
							intervalMs: 1500,
							maxAttempts: 8
						})
						this.clawBotTestDelivery = delivery
					}
					if (delivery.status === 'failed') throw new Error('WXPUSHER_CLAWBOT_TEST_FAILED')
					if (delivery.status !== 'delivered') throw new Error('WXPUSHER_CLAWBOT_TEST_PENDING')
					const received = await new Promise((resolve) => uni.showModal({
						title: '请确认微信直达',
						content: 'WxPusher 已确认投递。请只在微信 ClawBot 对话中确认；如果仅在 WxPusher App 收到，不要点“我收到了”。若没有 ClawBot 对话，请回 WxPusher App 的“我的 → 推送渠道”重新绑定。',
						confirmText: '我收到了',
						cancelText: '还没收到',
						success: (result) => resolve(!!result.confirm),
						fail: () => resolve(false)
					}))
					if (!received) {
						uni.showToast({ title: '未确认，不会标记为微信直达', icon: 'none' })
						return
					}
					const confirmed = await callBackend('/api/notifications/wxpusher-clawbot/confirm', {
						method: 'POST',
						data: { deliveryId: delivery.id }
					})
					this.clawBot = normalizeWxPusherClawBot(confirmed.clawBot || {})
					uni.showToast({ title: '微信直达已确认', icon: 'none' })
				} catch (error) {
					console.log('[notifications] clawbot verification failed', error)
					const copy = wxPusherClawBotErrorCopy(error)
					this.errorMessage = copy
					uni.showToast({ title: copy, icon: 'none' })
				} finally {
					this.clawBotLoading = false
				}
			},
			async startWxPusherBinding() {
				if (this.bindingLoading) return
				this.bindingLoading = true
				try {
					if (this.wxPusherBinding.qrImageUrl) {
						const status = await this.loadWxPusherBinding()
						if (status.deliveryReady) {
							this.wxPusherBinding = Object.assign({}, status, { qrImageUrl: '' })
							await this.loadDevices()
							uni.showToast({ title: '微信提醒已连接', icon: 'none' })
							return
						}
					}
					const result = await callBackend('/api/notifications/wxpusher-binding-challenge', { method: 'POST' })
					const binding = result.binding || {}
					this.wxPusherBinding = Object.assign({}, this.wxPusherBinding, binding, {
						provider: 'wxpusher',
						deliveryReady: false,
						qrImageUrl: binding.qrImageUrl ? buildUrl(binding.qrImageUrl) : ''
					})
				} catch (error) {
					console.log('[notifications] wxpusher challenge failed', error)
					uni.showToast({ title: '生成二维码失败', icon: 'none' })
				} finally {
					this.bindingLoading = false
				}
			},
			async removeWxPusherBinding() {
				if (this.bindingLoading) return
				const confirm = await new Promise((resolve) => uni.showModal({
					title: '解除消息绑定',
					content: '解除后，所有设备都会停止通过当前通道发送微信提醒。',
					success: (result) => resolve(!!result.confirm),
					fail: () => resolve(false)
				}))
				if (!confirm) return
				this.bindingLoading = true
				try {
					const result = await callBackend('/api/notifications/wxpusher-binding', { method: 'DELETE' })
					this.wxPusherBinding = Object.assign({}, result.binding || {}, {
						provider: 'wxpusher',
						deliveryReady: false,
						qrImageUrl: ''
					})
					await this.loadDevices()
				} catch (error) {
					uni.showToast({ title: '解除失败，请重试', icon: 'none' })
				} finally {
					this.bindingLoading = false
				}
			},
			resolveTrialBuild() {
				try {
					const wxApi = typeof wx !== 'undefined' ? wx : null
					const info = wxApi && typeof wxApi.getAccountInfoSync === 'function' ? wxApi.getAccountInfoSync() : null
					const envVersion = String(info && info.miniProgram && info.miniProgram.envVersion || '')
					return envVersion === 'trial' || envVersion === 'develop'
				} catch (error) {
					return false
				}
			},
			deviceState(sn) {
				return this.deviceStates[sn] || {
					longTerm: emptyLongTerm(),
					fallback: emptyFallback(),
					motionAlerts: { enabled: true },
					motionSaving: false,
					saving: false,
					testing: false,
					testDelivery: {}
				}
			},
			motionAlertEnabled(sn) {
				return this.deviceState(sn).motionAlerts.enabled !== false
			},
			async toggleMotionAlerts(device, event) {
				const state = this.deviceState(device.sn)
				if (state.motionSaving) return
				const enabled = !!(event && event.detail && event.detail.value)
				this.setDeviceState(device.sn, { motionSaving: true })
				try {
					const response = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/motion-alerts/preference', {
						method: 'PUT',
						data: { enabled }
					})
					this.setDeviceState(device.sn, {
						motionAlerts: response.preference || { enabled },
						motionSaving: false
					})
					uni.showToast({ title: enabled ? '移动记录已显示' : '移动记录已隐藏', icon: 'none' })
				} catch (error) {
					this.setDeviceState(device.sn, { motionSaving: false })
					uni.showToast({ title: '移动警报设置失败', icon: 'none' })
				}
			},
			setDeviceState(sn, patch) {
				const next = Object.assign({}, this.deviceState(sn), patch || {})
				if (typeof this.$set === 'function') this.$set(this.deviceStates, sn, next)
				else this.deviceStates[sn] = next
			},
			longTermStatus(sn) {
				const state = this.deviceState(sn)
				return state.saving ? '正在保存设置' : subscriptionStatusCopy(state.longTerm)
			},
			persistentAvailable(sn) {
				const state = this.deviceState(sn)
				return !!(state.longTerm.configured || this.wxPusherBinding.deliveryReady)
			},
			persistentEnabled(sn) {
				const state = this.deviceState(sn)
				return !!(state.longTerm.enabled || (this.wxPusherBinding.deliveryReady && state.fallback.enabled))
			},
			persistentStatus(sn) {
				const state = this.deviceState(sn)
				if (state.saving) return '正在保存设置'
				if (state.longTerm.enabled) return subscriptionStatusCopy(state.longTerm)
				if (this.wxPusherBinding.deliveryReady && state.fallback.enabled) {
					return 'WxPusher 微信提醒已开启'
				}
				if (state.longTerm.configured) return subscriptionStatusCopy(state.longTerm)
				if (!this.wxPusherBinding.deliveryReady) return '等待绑定微信提醒'
				return '连续提醒已关闭'
			},
			deliveryCopy(delivery) {
				if (delivery && delivery.status === 'pending' && !this.deviceState(delivery.deviceSn).testing) {
					return '仍在投递，可稍后刷新'
				}
				return notificationDeliveryCopy(delivery)
			},
			async togglePersistent(device, event) {
				if (this.deviceState(device.sn).longTerm.configured) return this.toggleLongTerm(device, event)
				return this.savePushPlusPreference(device, !!(event && event.detail && event.detail.value))
			},
			async savePushPlusPreference(device, enabled) {
				const state = this.deviceState(device.sn)
				if (state.saving || !this.wxPusherBinding.deliveryReady) return
				this.setDeviceState(device.sn, { saving: true })
				try {
					const response = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/notifications', {
						method: 'PUT',
						data: { enabled }
					})
					this.setDeviceState(device.sn, { fallback: response.notifications || emptyFallback(), saving: false })
					uni.showToast({ title: enabled ? '连续提醒已开启' : '提醒已关闭', icon: 'none' })
				} catch (error) {
					this.setDeviceState(device.sn, { saving: false })
					uni.showToast({ title: '设置失败，请重试', icon: 'none' })
				}
			},
			templateStatusCopy(item) {
				if (item && item.enabled) return item.status === 'acceptWithAudio' ? '已开启强提醒' : '已开启'
				if (item && item.status === 'reject') return '未允许'
				if (item && item.status === 'ban') return '模板不可用'
				return '待开启'
			},
			fallbackCount(sn, eventType) {
				const item = (this.deviceState(sn).fallback.templates || []).find((template) => template.eventType === eventType)
				return Number(item && item.remainingCount) || 0
			},
			async loadDevices() {
				if (this.loadingDevices) return
				this.loadingDevices = true
				this.errorMessage = ''
				try {
					await this.loadWxPusherBinding()
					const result = await callBackend('/api/devices')
					this.devices = Array.isArray(result.devices) ? result.devices : []
					const statuses = await Promise.all(this.devices.map(async (device) => {
						const [longTermResult, fallbackResult, motionResult] = await Promise.all([
							callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/wechat-device-subscription')
								.catch((error) => {
									console.log('[notifications] long-term status failed', device.sn, error)
									return { subscription: emptyLongTerm() }
								}),
							callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/notifications')
								.catch((error) => {
									console.log('[notifications] fallback status failed', device.sn, error)
									return { notifications: emptyFallback() }
								}),
							callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/motion-alerts/preference')
								.catch((error) => {
									console.log('[notifications] motion alert preference failed', device.sn, error)
									return { preference: { enabled: true } }
								})
						])
						return [device.sn, {
							longTerm: longTermResult.subscription || emptyLongTerm(),
							fallback: fallbackResult.notifications || emptyFallback(),
							motionAlerts: motionResult.preference || { enabled: true },
							motionSaving: false,
							saving: false,
							testing: false,
							testDelivery: this.deviceState(device.sn).testDelivery || {}
						}]
					}))
					statuses.forEach(([sn, state]) => this.setDeviceState(sn, state))
					this.longTermConfigured = statuses.some(([, state]) => !!state.longTerm.configured)
				} catch (error) {
					console.log('[notifications] devices failed', error)
					this.errorMessage = '设备和通知状态加载失败，请稍后重试'
				} finally {
					this.loadingDevices = false
				}
			},
			async toggleLongTerm(device, event) {
				const enabled = !!(event && event.detail && event.detail.value)
				if (enabled) {
					const accepted = (this.deviceState(device.sn).longTerm.templates || [])
						.some((item) => item.status === 'accept' || item.status === 'acceptWithAudio')
					if (accepted) {
						await this.saveLongTermEnabled(device, true)
						if (this.deviceState(device.sn).longTerm.enabled) return
					}
					await this.enableLongTerm(device)
					return
				}
				await this.saveLongTermEnabled(device, false)
			},
			async saveLongTermEnabled(device, enabled) {
				const state = this.deviceState(device.sn)
				if (state.saving || !state.longTerm.configured) return
				this.setDeviceState(device.sn, { saving: true })
				try {
					const response = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/wechat-device-subscription', {
						method: 'PUT',
						data: { enabled }
					})
					if (!enabled) {
						await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/notifications', {
							method: 'PUT',
							data: { enabled: false }
						}).catch(() => null)
					}
					this.setDeviceState(device.sn, { longTerm: response.subscription || emptyLongTerm(), saving: false })
					uni.showToast({ title: enabled ? '长期提醒已开启' : '提醒已关闭', icon: 'none' })
				} catch (error) {
					console.log('[notifications] long-term toggle failed', error)
					this.setDeviceState(device.sn, { saving: false })
					uni.showToast({ title: '设置失败，请重试', icon: 'none' })
				}
			},
			async enableLongTerm(device) {
				const state = this.deviceState(device.sn)
				if (state.saving || !state.longTerm.configured) return
				this.setDeviceState(device.sn, { saving: true })
				try {
					const ticketResponse = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/wechat-device-subscription-ticket', {
						method: 'POST'
					})
					const ticket = ticketResponse.ticket || {}
					const wxApi = typeof wx !== 'undefined' ? wx : null
					const raw = await requestSubscribeDeviceMessage(wxApi, ticket)
					const results = normalizeDeviceSubscriptionResult(raw, ticket.tmplIds)
					const saved = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/wechat-device-subscription', {
						method: 'PUT',
						data: { enabled: true, results }
					})
					const longTerm = saved.subscription || emptyLongTerm()
					this.setDeviceState(device.sn, { longTerm, saving: false })
					if (longTerm.enabled) {
						uni.showToast({ title: '长期提醒已开启', icon: 'none' })
					} else if (longTerm.partiallyEnabled) {
						uni.showModal({ title: '只开启了部分提醒', content: '还需要允许另一条进食提醒，才能完整接收开始和结束通知。', showCancel: false })
					} else {
						uni.showModal({ title: '长期提醒未开启', content: '需要在微信授权框中允许这台摄像头的进食提醒。', showCancel: false })
					}
				} catch (error) {
					console.log('[notifications] device subscribe failed', error)
					this.setDeviceState(device.sn, { saving: false })
					const unsupported = String(error && error.message || '').includes('WECHAT_DEVICE_SUBSCRIPTION_UNAVAILABLE')
					uni.showModal({
						title: '开启失败',
						content: unsupported ? '当前微信版本不支持硬件长期提醒，请升级微信后重试。' : '设备票据或微信模板暂时不可用，请稍后重试。',
						showCancel: false
					})
				}
			},
			async renewFallback(device) {
				const state = this.deviceState(device.sn)
				if (state.saving || !state.fallback.configured) return
				const templateIds = (state.fallback.templates || []).map((item) => item.templateId).filter(Boolean)
				this.setDeviceState(device.sn, { saving: true })
				try {
					const wxApi = typeof wx !== 'undefined' ? wx : null
					const raw = await requestSubscriptionMessage(wxApi, templateIds)
					const results = normalizeSubscriptionResult(raw, templateIds)
					const response = await callBackend('/api/devices/' + encodeURIComponent(device.sn) + '/notifications/subscription-result', {
						method: 'POST',
						data: { results }
					})
					const fallback = response.notifications || emptyFallback()
					this.setDeviceState(device.sn, { fallback, saving: false })
					uni.showToast({ title: fallback.totalRemaining > state.fallback.totalRemaining ? '临时提醒已领取' : '没有领取提醒', icon: 'none' })
				} catch (error) {
					console.log('[notifications] fallback subscribe failed', error)
					this.setDeviceState(device.sn, { saving: false })
					uni.showToast({ title: '领取失败，请重试', icon: 'none' })
				}
			},
			async sendTest(device, eventType) {
				const state = this.deviceState(device.sn)
				if (state.testing || !this.persistentEnabled(device.sn)) return
				this.setDeviceState(device.sn, {
					testing: true,
					testDelivery: { deviceSn: device.sn, status: 'pending' }
				})
				try {
					const path = state.longTerm.enabled
						? '/api/devices/' + encodeURIComponent(device.sn) + '/wechat-device-subscription/test'
						: '/api/devices/' + encodeURIComponent(device.sn) + '/notifications/test'
					const response = await callBackend(path, {
						method: 'POST',
						data: { eventType }
					})
					const submitted = normalizeNotificationDelivery(response.delivery || response.result || response)
					if (submitted.status === 'delivered') {
						this.setDeviceState(device.sn, { testing: false, testDelivery: Object.assign({ deviceSn: device.sn }, submitted) })
						uni.showToast({ title: submitted.provider === 'wxpusher' ? 'WxPusher 已接收，请以微信为准' : '微信已送达', icon: 'none' })
						return
					}
					if (!submitted.id) throw new Error('NOTIFICATION_DELIVERY_ID_MISSING')
					this.setDeviceState(device.sn, { testDelivery: Object.assign({ deviceSn: device.sn }, submitted) })
					uni.showToast({ title: '测试提醒已提交', icon: 'none' })
					const delivery = await waitForNotificationDelivery({
						deliveryId: submitted.id,
						loadDelivery: (deliveryId) => callBackend('/api/notifications/deliveries/' + encodeURIComponent(deliveryId))
					})
					this.setDeviceState(device.sn, {
						testing: false,
						testDelivery: Object.assign({ deviceSn: device.sn }, delivery)
					})
					uni.showToast({ title: delivery.status === 'delivered' ? (delivery.provider === 'wxpusher' ? 'WxPusher 已接收，请以微信为准' : '微信已送达') : (delivery.status === 'failed' ? '投递失败，请重试' : '仍在投递，可稍后查看'), icon: 'none' })
				} catch (error) {
					console.log('[notifications] test failed', error)
					this.setDeviceState(device.sn, {
						testing: false,
						testDelivery: { deviceSn: device.sn, status: 'failed', error: String(error && error.message || '') }
					})
					uni.showToast({ title: '投递失败，请稍后重试', icon: 'none' })
				} finally {
					this.setDeviceState(device.sn, { testing: false })
				}
			}
		}
	}
</script>

<style>
	.notification-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.notification-content { padding: 34rpx 32rpx 0; }
	.hidden-canvas { position: absolute; left: -9999px; top: -9999px; }
	.intro-copy { padding: 0 4rpx 30rpx; }
	.intro-label, .review-label, .fallback-label { display: block; color: #C9A24B; font-size: 21rpx; font-weight: 600; line-height: 32rpx; }
	.intro-title { display: block; margin-top: 10rpx; font-size: 36rpx; font-weight: 650; line-height: 50rpx; }
	.intro-text { display: block; margin-top: 10rpx; color: #5A5A56; font-size: 25rpx; line-height: 40rpx; }
	.state-card, .review-card, .device-card, .explain-card { margin-top: 20rpx; padding: 28rpx; border: 2rpx solid #E8E8E5; border-radius: 28rpx; background: #FFFFFF; }
	.binding-card { margin-bottom: 24rpx; padding: 28rpx; border: 2rpx solid #E8E8E5; border-radius: 28rpx; background: #FFFFFF; }
	.clawbot-card { margin-bottom: 24rpx; padding: 28rpx; border: 2rpx solid #E8E8E5; border-radius: 28rpx; background: #FFFFFF; }
	.binding-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20rpx; }
	.binding-title { display: block; font-size: 29rpx; font-weight: 650; line-height: 42rpx; }
	.binding-copy { display: block; margin-top: 6rpx; color: #8B8B88; font-size: 22rpx; line-height: 34rpx; }
	.binding-badge { flex: none; padding: 8rpx 16rpx; border-radius: 999rpx; background: #F1F1EF; color: #8B8B88; font-size: 20rpx; line-height: 30rpx; }
	.binding-badge.active { background: #F1F1EF; color: #2FA35C; }
	.binding-qr { display: block; width: 360rpx; height: 360rpx; margin: 24rpx auto 0; border-radius: 20rpx; background: #F1F1EF; }
	.binding-step { margin-top: 24rpx; padding-top: 22rpx; border-top: 2rpx solid #EDEDEB; }
	.binding-step-index { color: #C9A24B; font-size: 20rpx; font-weight: 650; line-height: 30rpx; }
	.binding-step-title { margin-left: 14rpx; font-size: 23rpx; font-weight: 600; line-height: 34rpx; }
	.binding-tip, .binding-warning { display: block; margin-top: 14rpx; color: #8B8B88; font-size: 21rpx; line-height: 34rpx; text-align: center; }
	.binding-warning { color: #9A4A40; }
	.binding-unbind { margin-top: 22rpx; }
	.clawbot-state-copy { display: block; margin-top: 20rpx; color: #5A5A56; font-size: 23rpx; line-height: 36rpx; }
	.clawbot-meta { margin-top: 18rpx; padding: 18rpx 20rpx; border-radius: 16rpx; background: #F1F1EF; }
	.clawbot-meta text { display: block; color: #5A5A56; font-size: 21rpx; line-height: 34rpx; }
	.clawbot-activation { margin-top: 18rpx; padding-top: 18rpx; border-top: 2rpx solid #EDEDEB; }
	.clawbot-entry-label { display: block; color: #5A5A56; font-size: 22rpx; font-weight: 600; line-height: 34rpx; text-align: center; }
	.clawbot-qr-shell { width: 440rpx; height: 440rpx; margin: 22rpx auto 0; padding: 16rpx; box-sizing: border-box; border: 2rpx solid #E8E8E5; border-radius: 20rpx; background: #FFFFFF; }
	.clawbot-qr { display: block; width: 100%; height: 100%; background: #FFFFFF; }
	.qr-open-button { width: 100%; margin-top: 18rpx; }
	.clawbot-steps { margin-top: 18rpx; padding: 18rpx 20rpx; border-radius: 18rpx; background: #F1F1EF; }
	.clawbot-steps text { display: block; color: #5A5A56; font-size: 21rpx; line-height: 36rpx; }
	.clawbot-compatibility { display: block; margin-top: 16rpx; padding: 18rpx 20rpx; border-radius: 18rpx; color: #5A5A56; background: #F1F1EF; font-size: 20rpx; line-height: 34rpx; }
	.clawbot-test-copy { display: block; margin-top: 14rpx; color: #5A5A56; font-size: 21rpx; line-height: 34rpx; text-align: center; }
	.clawbot-footnote { display: block; margin-top: 16rpx; color: #989893; font-size: 20rpx; line-height: 32rpx; }
	.state-title, .review-title, .explain-title { display: block; font-size: 29rpx; font-weight: 650; line-height: 42rpx; }
	.state-copy, .review-copy, .explain-copy { display: block; margin-top: 8rpx; color: #8B8B88; font-size: 23rpx; line-height: 36rpx; }
	.device-section { margin-top: 4rpx; }
	.device-heading { display: flex; align-items: center; justify-content: space-between; }
	.device-copy { flex: 1; min-width: 0; }
	.device-name { display: block; font-size: 29rpx; font-weight: 650; line-height: 42rpx; }
	.device-role { display: block; margin-top: 3rpx; color: #989893; font-size: 22rpx; line-height: 34rpx; }
	.device-status-row { display: flex; align-items: center; margin-top: 22rpx; }
	.status-dot { width: 12rpx; height: 12rpx; border-radius: 50%; background: #C4C4C0; }
	.status-dot.active { background: #2FA35C; }
	.device-status { margin-left: 12rpx; color: #5A5A56; font-size: 22rpx; line-height: 32rpx; }
	.motion-setting-row { display: flex; align-items: center; gap: 24rpx; margin-top: 22rpx; padding-top: 22rpx; border-top: 2rpx solid #EDEDEB; }
	.motion-setting-copy { flex: 1; min-width: 0; }
	.motion-setting-title { display: block; font-size: 24rpx; font-weight: 650; line-height: 36rpx; }
	.motion-setting-note { display: block; margin-top: 4rpx; color: #8B8B88; font-size: 20rpx; line-height: 31rpx; }
	.template-row { display: flex; align-items: stretch; margin-top: 22rpx; border-top: 2rpx solid #EDEDEB; border-bottom: 2rpx solid #EDEDEB; }
	.template-item { flex: 1; padding: 18rpx 0; }
	.template-item + .template-item { padding-left: 22rpx; border-left: 2rpx solid #EDEDEB; }
	.template-label, .template-value { display: block; font-size: 22rpx; line-height: 34rpx; }
	.template-value { color: #8B8B88; }
	.template-value.accepted { color: #2FA35C; }
	.primary-button, .fallback-button { height: 78rpx; margin-top: 22rpx; border: 0; border-radius: 18rpx; font-size: 24rpx; line-height: 78rpx; }
	.primary-button { background: #141414; color: #FFFFFF; }
	.fallback-button { background: #F1F1EF; color: #141414; }
	.primary-button[disabled], .fallback-button[disabled] { background: #D8D8D5; color: #FFFFFF; }
	.primary-button::after, .fallback-button::after, .secondary-button::after { border: 0; }
	.test-actions { display: flex; gap: 14rpx; margin-top: 18rpx; }
	.delivery-band { margin-top: 14rpx; padding: 14rpx 18rpx; border-radius: 14rpx; background: #F1F1EF; }
	.delivery-band text { color: #5A5A56; font-size: 21rpx; line-height: 32rpx; }
	.delivery-band.delivered text { color: #2FA35C; }
	.delivery-band.failed text { color: #9A4A40; }
	.secondary-button { flex: 1; height: 68rpx; margin: 0; border: 2rpx solid #DBDBD8; border-radius: 16rpx; background: #FFFFFF; color: #141414; font-size: 22rpx; line-height: 64rpx; }
	.pending-band { margin-top: 22rpx; padding: 20rpx 22rpx; border-radius: 18rpx; background: #F1F1EF; }
	.pending-title { display: block; font-size: 24rpx; font-weight: 650; line-height: 36rpx; }
	.pending-copy { display: block; margin-top: 5rpx; color: #5A5A56; font-size: 21rpx; line-height: 32rpx; }
	.fallback-section { margin-top: 24rpx; padding-top: 22rpx; border-top: 2rpx solid #E8E8E5; }
	.quota-row { display: flex; align-items: stretch; margin-top: 10rpx; }
	.quota-item { flex: 1; }
	.quota-item:last-child { padding-left: 22rpx; }
	.quota-label, .quota-value { display: block; font-size: 21rpx; line-height: 32rpx; }
	.quota-value { color: #8B8B88; }
	.quota-divider { width: 2rpx; background: #EDEDEB; }
	.fallback-tip { display: block; margin-top: 12rpx; color: #989893; font-size: 20rpx; line-height: 32rpx; }
	.review-card { background: #FBFBFA; }
	.review-title { margin-top: 7rpx; }
	.explain-card { margin-top: 28rpx; }
	.error-band { margin-top: 20rpx; padding: 20rpx 22rpx; border: 2rpx solid #9A4A40; border-radius: 16rpx; }
	.error-band text { color: #9A4A40; font-size: 22rpx; line-height: 34rpx; }
	.bottom-safe { height: calc(36rpx + env(safe-area-inset-bottom)); }
</style>
