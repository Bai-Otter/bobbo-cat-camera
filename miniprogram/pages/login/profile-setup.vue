<template>
	<view class="setup-page">
		<view class="setup-header">
			<text class="setup-title">完善资料</text>
			<text class="setup-desc">选个头像、填个昵称，让大家认识你</text>
		</view>

		<!-- 大头像位 -->
		<view class="avatar-zone">
			<button class="avatar-pick" open-type="chooseAvatar" @chooseavatar="onChooseAvatar">
				<image v-if="avatarUrl" class="avatar-img" :src="avatarUrl" mode="aspectFill" />
				<view v-else class="avatar-empty">
					<cat-icon name="camera" :size="64" color="#989893" />
					<text class="avatar-empty-text">点击选择头像</text>
				</view>
			</button>
			<text class="avatar-tip">{{ avatarUrl ? '已选择，可点击更换' : '从微信头像快速选择' }}</text>
		</view>

		<!-- 昵称输入：focus 自动弹起微信昵称面板 -->
		<view class="nickname-zone">
			<text class="field-label">昵称</text>
			<input class="nickname-input" type="nickname" v-model="nickname"
				:focus="autoFocus" placeholder="点击填写昵称" maxlength="20"
				@blur="onNicknameBlur" @confirm="onNicknameConfirm" />
		</view>

		<!-- 完成 -->
		<view class="action-zone">
			<button class="btn-primary" :disabled="!canFinish || saving" @click="finish">
				<text class="btn-text">{{ saving ? '保存中...' : '完成' }}</text>
			</button>
			<view class="skip-row" @click="skip">
				<text class="skip-text">稍后设置，直接进入</text>
			</view>
		</view>
	</view>
</template>
<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { readUserProfile, writeUserProfile } = require('@/utils/appAuth.js')
	const { postLoginRoute } = require('@/utils/shareInvite.js')
	const { uploadUserAvatar } = require('@/utils/userAvatar.js')

	export default {
		components: { catIcon },
		data() {
			return {
				avatarUrl: '',
				nickname: '',
				autoFocus: false,
				saving: false,
				openid: '',
				cloudOk: false
			}
		},
		computed: {
			canFinish() {
				return !!this.avatarUrl && !!(this.nickname && this.nickname.trim())
			}
		},
		onLoad() {
			this.readUserProfile()
			this.prefillFromCloud()
			// 进页面 220ms 后自动 focus 昵称输入框，触发微信昵称面板
			setTimeout(() => { this.autoFocus = true }, 220)
		},
		methods: {
			readUserProfile() {
				try {
					const raw = uni.getStorageSync('userProfile')
					if (raw) {
						const info = typeof raw === 'string' ? JSON.parse(raw) : raw
						this.openid = info.openid || ''
						this.cloudOk = !!info.cloudOk
					}
				} catch (e) {
					console.log('[setup] 读 userProfile 失败', e)
				}
			},

			// 调云函数 login 拿云端已有 profile 用于预填
			prefillFromCloud() {
				// #ifdef MP-WEIXIN
				if (!this.cloudOk) {
					callBackend('/api/profile')
						.then((result) => {
							const p = (result && result.profile) || {}
							if (p.avatar && !this.avatarUrl) this.avatarUrl = p.avatar
							if (p.nickname && !this.nickname) this.nickname = p.nickname
						})
						.catch((error) => console.log('[setup] 本机 profile 预填失败', error))
					return
				}
				if (!wx.cloud) return
				wx.cloud.callFunction({
					name: 'login',
					data: {},
					success: (res) => {
						const result = (res && res.result) || {}
						const p = result.profile || {}
						console.log('[setup] 云端 profile', p)
						if (p.avatar && !this.avatarUrl) this.avatarUrl = p.avatar
						if (p.nickname && !this.nickname) this.nickname = p.nickname
					},
					fail: (err) => {
						console.log('[setup] 云函数 login 失败', err)
					}
				})
				// #endif
			},

			// 选头像 → saveFile 转永久路径
			onChooseAvatar(e) {
				const tempPath = e && e.detail && e.detail.avatarUrl
				console.log('[setup] chooseAvatar', tempPath)
				if (!tempPath) return
				this.avatarUrl = tempPath
				this.persistAvatar(tempPath)
			},

			persistAvatar(tempPath) {
				try {
					const fs = wx.getFileSystemManager()
					fs.saveFile({
						tempFilePath: tempPath,
						success: (r) => {
							console.log('[setup] saveFile success', r.savedFilePath)
							this.avatarUrl = r.savedFilePath
						},
						fail: (err) => {
							console.log('[setup] saveFile fail', err)
						}
					})
				} catch (e) {
					console.log('[setup] saveFile 异常', e)
				}
			},

			onNicknameBlur(e) {
				const v = (e.detail && e.detail.value) || this.nickname
				this.nickname = String(v).trim()
			},
			onNicknameConfirm(e) { this.onNicknameBlur(e) },

			// 完成：写云端 users（按 openid）+ 进首页
			async finish() {
				if (!this.canFinish || this.saving) return
				this.saving = true
				let persistedAvatar = this.avatarUrl
				try {
					persistedAvatar = await uploadUserAvatar({ filePath: this.avatarUrl, wxApi: wx, uniApi: uni })
					this.avatarUrl = persistedAvatar
				} catch (error) {
					this.saving = false
					console.log('[setup] avatar upload failed', error)
					uni.showToast({ title: '头像上传失败，请重试', icon: 'none' })
					return
				}
				const payload = {
					avatar: persistedAvatar,
					nickname: this.nickname.trim()
				}
				writeUserProfile(Object.assign({}, readUserProfile(), payload))
				// #ifdef MP-WEIXIN
				if (this.cloudOk && wx.cloud) {
					wx.cloud.callFunction({
						name: 'updateProfile',
						data: payload,
						success: (res) => {
							console.log('[setup] updateProfile ok', res && res.result)
							this.saving = false
							uni.showToast({ title: '已保存', icon: 'success', duration: 800 })
							setTimeout(() => uni.reLaunch({ url: postLoginRoute() }), 600)
						},
						fail: (err) => {
							console.log('[setup] updateProfile 失败', err)
							this.saving = false
							uni.showToast({ title: '云端保存失败，已暂存本地', icon: 'none' })
							setTimeout(() => uni.reLaunch({ url: postLoginRoute() }), 800)
						}
					})
					return
				}
				// #endif
				callBackend('/api/profile', {
					method: 'PATCH',
					data: payload
				})
					.then((result) => {
						const profile = (result && result.profile) || payload
						writeUserProfile(Object.assign({}, readUserProfile(), profile))
						uni.showToast({ title: '已保存', icon: 'success', duration: 800 })
					})
					.catch((error) => {
						console.log('[setup] 本机 profile 保存失败，已暂存本地', error)
						uni.showToast({ title: '服务器暂不可用，已暂存本机', icon: 'none' })
					})
					.finally(() => {
						this.saving = false
						setTimeout(() => uni.reLaunch({ url: postLoginRoute() }), 600)
					})
			},

			skip() {
				uni.reLaunch({ url: postLoginRoute() })
			}
		}
	}
</script>
<style lang="scss" scoped>
	.setup-page {
		min-height: 100vh;
		box-sizing: border-box;
		background: #FBFBFA;
		padding: calc(72rpx + constant(safe-area-inset-top)) 48rpx 40rpx;
		padding: calc(72rpx + env(safe-area-inset-top)) 48rpx 40rpx;
		display: flex;
		flex-direction: column;
	}
	.setup-header { text-align: center; margin-bottom: 48rpx; }
	.setup-title {
		display: block;
		font-size: 40rpx;
		font-weight: 700;
		color: #141414;
		margin-bottom: 12rpx;
	}
	.setup-desc {
		display: block;
		font-size: 26rpx;
		color: #989893;
	}

	.avatar-zone { text-align: center; margin-bottom: 48rpx; }
	.avatar-pick {
		width: 184rpx; height: 184rpx;
		padding: 0; margin: 0 auto;
		background: #FFFFFF;
		border-radius: 50%;
		border: 2rpx solid #EDEDEB;
		display: flex; align-items: center; justify-content: center;
		overflow: hidden;
	}
	.avatar-pick::after { border: none; }
	.avatar-img { width: 184rpx; height: 184rpx; border-radius: 50%; }
	.avatar-empty { display: flex; flex-direction: column; align-items: center; gap: 12rpx; }
	.avatar-empty-text { font-size: 23rpx; color: #989893; }
	.avatar-tip {
		display: block;
		margin-top: 24rpx;
		font-size: 24rpx;
		color: #989893;
	}

	.nickname-zone { margin-bottom: 40rpx; }
	.field-label {
		display: block;
		font-size: 26rpx;
		font-weight: 600;
		color: #5A5A56;
		margin-bottom: 16rpx;
		padding-left: 8rpx;
	}
	.nickname-input {
		background: #FFFFFF;
		border: 2rpx solid #EDEDEB;
		border-radius: 16rpx;
		padding: 28rpx 30rpx;
		font-size: 32rpx;
		color: #141414;
	}

	.action-zone {
		margin-top: auto;
		padding-bottom: calc(32rpx + constant(safe-area-inset-bottom));
		padding-bottom: calc(32rpx + env(safe-area-inset-bottom));
	}
	.btn-primary {
		display: flex; align-items: center; justify-content: center;
		background: #141414;
		color: #ffffff;
		border-radius: 16rpx;
		padding: 32rpx 0;
		font-size: 32rpx;
		font-weight: 600;
		margin-bottom: 24rpx;
	}
	.btn-primary[disabled] { background: #C4C4C0; }
	.btn-primary::after { border: none; }
	.btn-text { color: #ffffff; font-size: 32rpx; font-weight: 600; }

	.skip-row { text-align: center; padding: 16rpx 0; }
	.skip-text {
		font-size: 24rpx;
		color: #989893;
		text-decoration: underline;
	}
</style>
