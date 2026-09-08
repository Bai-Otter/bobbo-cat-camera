<template>
	<view class="accept-page">
		<bobbo-nav-bar title="家庭共享" title-align="left"></bobbo-nav-bar>
		<view class="accept-content">
			<view class="state-mark" :class="state"><cat-icon :name="stateIcon" :size="44" color="#141414" /></view>
			<text class="state-title">{{ title }}</text>
			<text class="state-copy">{{ copy }}</text>
			<button v-if="state === 'failed'" class="primary-button" @click="handleFailureAction">{{ failureActionLabel }}</button>
			<button v-if="state === 'success'" class="primary-button" @click="enterHome">进入今日</button>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { readAppAuthState } = require('@/utils/appAuth.js')
	const {
		clearPendingShareToken,
		captureShareToken,
		normalizeShareToken,
		readPendingShareToken,
		savePendingShareToken
	} = require('@/utils/shareInvite.js')
	const { replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')

	export default {
		components: { catIcon },
		data() {
			return { token: '', state: 'loading', errorCode: '', redeeming: false }
		},
		computed: {
			stateIcon() { return this.state === 'success' ? 'check' : this.state === 'failed' ? 'info' : 'share' },
			title() { return this.state === 'success' ? '共享设备已加入' : this.state === 'failed' ? '这份邀请暂时无法使用' : '正在加入家庭设备' },
			copy() {
				if (this.state === 'success') return '你现在可以查看实时画面、回放、今日数据和吃播。'
				if (this.errorCode === 'SHARE_INVITE_EXPIRED') return '邀请已超过 24 小时，请让设备主人重新生成。'
				if (this.errorCode === 'SHARE_INVITE_USED') return '邀请已经被领取，请让设备主人重新生成。'
				if (this.errorCode === 'SHARE_INVITE_CANCELLED') return '邀请已被设备主人取消。'
				if (this.errorCode === 'DEVICE_MEMBER_LIMIT_REACHED') return '这个设备的家庭成员已满。'
				return this.state === 'failed' ? '请检查网络，或向设备主人获取新的邀请。' : '领取后会自动进入布卜布卜。'
			},
			terminalFailure() {
				return ['SHARE_INVITE_EXPIRED', 'SHARE_INVITE_USED', 'SHARE_INVITE_CANCELLED', 'DEVICE_MEMBER_LIMIT_REACHED'].includes(this.errorCode)
			},
			failureActionLabel() { return this.terminalFailure ? '返回首页' : '重试' }
		},
		onLoad(options = {}) {
			this.token = captureShareToken(options) || normalizeShareToken(options.token) || readPendingShareToken()
			if (this.token) savePendingShareToken(this.token)
			const auth = readAppAuthState()
			if (!auth.hasSession) {
				uni.reLaunch({ url: '/pages/login/index' })
				return
			}
			this.redeem()
		},
		methods: {
			async redeem() {
				if (this.redeeming || this.state === 'success') return
				if (!this.token) {
					this.state = 'failed'
					this.errorCode = 'SHARE_INVITE_TOKEN_REQUIRED'
					return
				}
			this.state = 'loading'
			this.errorCode = ''
			this.redeeming = true
			try {
				await callBackend('/api/share-invites/redeem', { method: 'POST', data: { token: this.token } })
				clearPendingShareToken()
				this.state = 'success'
				try {
					const devices = await callBackend('/api/devices')
					replaceOwnedDevices(devices.devices || [], uni)
				} catch (refreshError) {
					console.warn('[share] device cache refresh deferred', refreshError)
				}
			} catch (error) {
				this.errorCode = String((error && (error.code || error.message)) || '')
				this.state = 'failed'
			} finally { this.redeeming = false }
		},
		handleFailureAction() { this.terminalFailure ? this.enterHome() : this.redeem() },
		enterHome() { uni.reLaunch({ url: '/pages/today/index' }) }
		}
	}
</script>

<style lang="scss" scoped>
	.accept-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.accept-content { min-height: 720rpx; padding: 140rpx 56rpx 80rpx; display: flex; flex-direction: column; align-items: center; text-align: center; box-sizing: border-box; }
	.state-mark { width: 112rpx; height: 112rpx; border-radius: 50%; background: #E8E8E5; display: flex; align-items: center; justify-content: center; }
	.state-mark.success { background: #DDF1E5; }
	.state-mark.failed { background: #F3E3DF; }
	.state-title { margin-top: 38rpx; font-size: 38rpx; line-height: 52rpx; font-weight: 650; }
	.state-copy { max-width: 560rpx; margin-top: 18rpx; color: #74746F; font-size: 25rpx; line-height: 40rpx; }
	.primary-button { width: 100%; min-height: 88rpx; margin-top: 56rpx; border: 0; border-radius: 14rpx; background: #141414; color: #FFFFFF; font-size: 28rpx; display: flex; align-items: center; justify-content: center; }
	.primary-button::after { border: 0; }
</style>
