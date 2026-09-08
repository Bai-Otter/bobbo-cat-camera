<template>
	<view class="feedback-page">
		<bobbo-nav-bar title="反馈" title-align="left"></bobbo-nav-bar>
		<view class="page-content">
		<view class="page-header">
			<text class="page-desc">把问题、建议或想保留的素材告诉我们。</text>
		</view>

		<view class="type-row">
			<view class="type-chip" v-for="item in types" :key="item" :class="{active: type === item}" @click="type = item">
				<text class="type-text">{{item}}</text>
			</view>
		</view>

		<view class="form-card">
			<textarea class="content-input" v-model="content" maxlength="1000" placeholder="例如：直播偶尔卡住、某段吃饭视频很好玩、希望提醒文案更可爱..." />
			<view class="form-divider"></view>
			<input class="contact-input" v-model="contact" placeholder="联系方式（选填）" />
		</view>

		<view class="submit-btn" :class="{disabled: submitting}" @click="submit">
			<text class="submit-text">{{submitting ? '提交中...' : '提交反馈'}}</text>
		</view>
		</view>
	</view>
</template>

<script>
	const { callBackend } = require('@/utils/backendClient.js')
	const { callDemoData } = require('@/utils/demoCloud.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')

	export default {
		data() {
			return {
				types: ['问题', '建议', '素材'],
				type: '问题',
				content: '',
				contact: '',
				deviceSn: '',
				submitting: false
			}
		},
		onLoad() {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.loadDevice()
		},
		methods: {
			async loadDevice() {
				try {
					const result = await callBackend('/api/devices')
					const devices = Array.isArray(result.devices) ? result.devices : []
					this.deviceSn = devices[0] ? devices[0].sn || '' : ''
				} catch (e) {
					console.log('[feedback] load device failed', e)
				}
			},
			async submit() {
				if (this.submitting) return
				const content = String(this.content || '').trim()
				if (!content) {
					uni.showToast({ title: '请先写一点反馈内容', icon: 'none' })
					return
				}
				this.submitting = true
				const res = await callDemoData('submitFeedback', {
					type: this.type,
					content,
					contact: this.contact,
					deviceSn: this.deviceSn
				})
				this.submitting = false
				if (res.ok) {
					uni.showToast({ title: '已收到，谢谢你', icon: 'success' })
					setTimeout(() => uni.navigateBack(), 800)
				} else {
					uni.showToast({ title: '提交失败，请稍后再试', icon: 'none' })
				}
			}
		}
	}
</script>

<style>
	.feedback-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.page-content { padding: 32rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); }
	.page-header { margin-bottom: 28rpx; }
	.page-desc { display: block; font-size: 26rpx; color: #989893; line-height: 1.5; }
	.type-row { display: flex; gap: 16rpx; margin-bottom: 28rpx; }
	.type-chip { min-width: 120rpx; box-sizing: border-box; padding: 14rpx 28rpx; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 14rpx; text-align: center; }
	.type-chip.active { background: #141414; border-color: #141414; }
	.type-text { font-size: 28rpx; color: #5A5A56; font-weight: 600; }
	.type-chip.active .type-text { color: #fff; }
	.form-card { background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 28rpx 30rpx; }
	.content-input { width: 100%; height: 320rpx; font-size: 30rpx; color: #141414; line-height: 1.6; }
	.contact-input { height: 88rpx; line-height: 88rpx; font-size: 30rpx; color: #141414; }
	.form-divider { height: 2rpx; background: #EFEFED; margin-top: 20rpx; }
	.submit-btn { display: flex; align-items: center; justify-content: center; min-height: 88rpx; box-sizing: border-box; margin-top: 36rpx; padding: 24rpx 0; border-radius: 16rpx; background: #141414; }
	.submit-btn.disabled { opacity: 0.6; }
	.submit-text { font-size: 32rpx; font-weight: 700; color: #fff; }
</style>
