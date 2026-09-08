<template>
	<view class="repair-page">
		<bobbo-nav-bar title="手动绑定" title-align="left"></bobbo-nav-bar>
		<view class="page-content">
		<view class="page-header">
			<text class="page-desc">输入设备序列号和登录信息</text>
		</view>

		<view class="form-card">
			<view class="form-row">
				<text class="form-label">序列号 SN</text>
				<input class="form-input" v-model="sn" placeholder="设备底部标签上的 SN" />
			</view>
			<view class="form-divider"></view>
			<view class="form-row">
				<text class="form-label">用户名</text>
				<input class="form-input" v-model="username" placeholder="默认 admin" />
			</view>
			<view class="form-divider"></view>
			<view class="form-row">
				<text class="form-label">密码</text>
				<input class="form-input" v-model="password" placeholder="设备登录密码" :password="!showPwd" />
				<view class="pwd-toggle" @click="showPwd = !showPwd">
					<cat-icon :name="showPwd ? 'check' : 'info'" :size="32" color="#989893" />
				</view>
			</view>
			<view class="form-divider"></view>
			<view class="form-row">
				<text class="form-label">设备昵称</text>
				<input class="form-input" v-model="nickname" placeholder="给设备起个名字" />
			</view>
		</view>

		<view class="tip-card">
			<cat-icon name="info" :size="36" color="#989893" />
			<view class="tip-text">
				<text class="tip-line">SN 在设备底部标签上，密码是设备登录密码，不是 WiFi 密码。</text>
				<text class="tip-line">如果设备默认空密码，可以不填写密码直接绑定。</text>
			</view>
		</view>

		<view class="primary-btn" :class="{disabled: binding}" @click="bindDevice">
			<text class="primary-btn-text">{{binding ? '绑定中...' : '绑定设备'}}</text>
		</view>

		<view class="status-line" v-if="statusText">
			<text class="status-text">{{statusText}}</text>
		</view>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend } = require('@/utils/backendClient.js')
	const { upsertOwnedDevice } = require('@/utils/ownedDeviceCache.js')

	export default {
		components: { catIcon },
		data() {
			return {
				sn: '',
				username: 'admin',
				password: '',
				nickname: '',
				showPwd: false,
				binding: false,
				statusText: ''
			}
		},
		onLoad(options) {
			if (options && options.sn) this.sn = decodeURIComponent(options.sn)
		},
		methods: {
			ensureAppAuth() {
				return !!ensureAppSession({ message: '请先登录' })
			},
			validateForm() {
				const payload = {
					sn: this.sn.trim(),
					username: this.username.trim() || 'admin',
					password: this.password.trim(),
					nickname: this.nickname.trim() || '摄像头'
				}
				if (!payload.sn) {
					uni.showToast({ title: '请输入序列号', icon: 'none' })
					return null
				}
				return payload
			},
			bindDevice() {
				if (this.binding) return
				if (!this.ensureAppAuth()) return
				const payload = this.validateForm()
				if (!payload) return
				this.binding = true
				this.statusText = '正在绑定...'
				callBackend('/api/devices', {
					method: 'POST',
					data: payload
				})
					.then((result) => {
						upsertOwnedDevice((result && result.device) || payload, uni)
						this.statusText = '绑定成功'
						uni.showToast({ title: '绑定成功', icon: 'success', duration: 1500 })
						setTimeout(() => uni.navigateBack({ delta: 2 }), 1500)
					})
					.catch((err) => {
						console.log('[manual] bind failed', err)
						this.statusText = '绑定失败：' + ((err && err.message) || '请稍后重试')
						uni.showToast({ title: '绑定失败', icon: 'none' })
					})
					.finally(() => {
						this.binding = false
					})
			}
		}
	}
</script>

<style>
	.repair-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.page-content { padding: 32rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); }
	.page-header { padding: 4rpx 0 28rpx; }
	.page-desc { font-size: 26rpx; color: #989893; }
	.form-card { background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 8rpx 28rpx; margin-bottom: 28rpx; }
	.form-row { display: flex; align-items: center; padding: 32rpx 0; }
	.form-label { font-size: 28rpx; font-weight: 600; color: #141414; width: 176rpx; flex-shrink: 0; }
	.form-input { flex: 1; min-width: 0; height: 72rpx; line-height: 72rpx; padding: 0 4rpx; box-sizing: border-box; font-size: 28rpx; color: #141414; }
	.form-divider { height: 2rpx; background: #EFEFED; }
	.pwd-toggle { padding: 8rpx; }
	.tip-card { display: flex; gap: 16rpx; background: #F1F1EF; border-radius: 14rpx; padding: 24rpx; margin-bottom: 36rpx; }
	.tip-text { flex: 1; }
	.tip-line { display: block; font-size: 24rpx; color: #5A5A56; line-height: 1.7; }
	.primary-btn { display: flex; align-items: center; justify-content: center; gap: 12rpx; min-height: 88rpx; box-sizing: border-box; background: #141414; border-radius: 16rpx; padding: 24rpx 0; }
	.primary-btn.disabled { opacity: 0.6; }
	.primary-btn-text { font-size: 32rpx; color: #fff; font-weight: 600; }
	.status-line { text-align: center; margin-top: 32rpx; }
	.status-text { font-size: 26rpx; color: #5A5A56; }
</style>
