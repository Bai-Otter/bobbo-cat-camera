<template>
	<view class="settings-page">
		<bobbo-nav-bar title="设置" title-align="left"></bobbo-nav-bar>
		<view class="settings-content">
			<view class="account-summary" @click="showUnavailable('账号与家庭')">
				<image class="account-avatar" :src="avatar" mode="aspectFill" />
				<view class="account-copy">
					<text class="account-name">{{ familyName }}</text>
					<text class="account-meta">与 1 位成员共享</text>
				</view>
				<text class="row-arrow">›</text>
			</view>

			<view class="section-divider"></view>
			<text class="section-label">画面与录制</text>
			<view class="settings-section">
				<view class="settings-row" @click="goTo('/pages/profile/device-storage?mode=picture')">
					<text class="row-title">基本设置</text>
					<text class="row-meta">提示音 · 画面方向 · 音量</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="goTo('/pages/profile/device-storage?mode=storage')">
					<text class="row-title">存储管理</text>
					<text class="row-meta">按设备查看</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="goTo('/pages/profile/device-storage?mode=recording')">
					<text class="row-title">录像设置</text>
					<text class="row-meta">持续录像 · 警报截图</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="goTo('/pages/profile/foodcast-preferences')">
					<text class="row-title">吃播剪辑偏好</text>
					<text class="row-meta">{{ foodcastModeLabel }}</text>
					<text class="row-arrow">›</text>
				</view>
			</view>

			<view class="section-divider"></view>
			<text class="section-label">提醒与识别</text>
			<view class="settings-section">
				<view class="settings-row" @click="goTo('/pages/profile/notifications')">
					<text class="row-title">智能提醒</text>
					<text class="row-meta">进食 · 异常 · 离线</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="goTo('/pages/profile/cats')">
					<text class="row-title">猫脸识别与档案</text>
					<text class="row-meta">{{ catCount }} 只 · 本地档案</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="showUnavailable('网络设置')">
					<text class="row-title">网络设置</text>
					<text class="row-meta">helloiip</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row settings-row-tall">
					<view class="row-copy">
						<text class="row-title">仅 Wi-Fi 下上传</text>
						<text class="row-description">蜂窝网络下暂存在设备</text>
					</view>
					<switch class="wifi-upload-switch" :checked="wifiOnly" color="#141414" @change="toggleWifiOnly" />
				</view>
			</view>

			<view class="section-divider"></view>
			<text class="section-label">账号与设备</text>
			<view class="settings-section">
				<view class="settings-row" @click="goTo('/pages/device/index')">
					<text class="row-title">设备管理</text>
					<text class="row-meta">3 台 · 2 在线</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="goTo('/pages/profile/share-device')">
					<text class="row-title">成员共享</text>
					<text class="row-meta">2 人 · 权限相同</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="showUnavailable('高级设置')">
					<text class="row-title">高级设置</text>
					<text class="row-meta">画质 自动</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="showUnavailable('添加到桌面')">
					<text class="row-title">添加到桌面</text>
					<text class="row-arrow">›</text>
				</view>
				<view class="settings-row" @click="showUnavailable('关于 bobbo')">
					<text class="row-title">关于 bobbo</text>
					<text class="row-meta">v1.4.0 · 已是最新</text>
					<text class="row-arrow">›</text>
				</view>
			</view>

			<button class="logout-button" @click="logout">退出登录</button>
			<text class="logout-note">退出后设备仍保留在账号下，重新登录即可继续查看</text>
		</view>
	</view>
</template>

<script>
	const { clearAppSession, ensureAppSession, readUserProfile } = require('@/utils/appAuth.js')
	const DEFAULT_AVATAR = '/static/images/cool-cat-avatar.svg'
	const CAT_PROFILES_KEY = 'bobbo_cat_profiles'
	const FOODCAST_PREFERENCES_KEY = 'bobbo_foodcast_ui_preferences'
	const WIFI_ONLY_UPLOAD_KEY = 'bobbo_wifi_only_upload'

	export default {
		name: 'profile-settings',
		data() {
			return {
				avatar: DEFAULT_AVATAR,
				familyName: '我的家',
				catCount: 2,
				foodcastModeLabel: '萌脸快剪',
				wifiOnly: true
			}
		},
		onShow() {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.loadAccountSummary()
		},
		methods: {
			loadAccountSummary() {
				const profile = readUserProfile()
				this.avatar = profile.avatar || DEFAULT_AVATAR
				this.familyName = `${profile.nickname || '微信用户'} 的家`
				try {
					const cats = uni.getStorageSync(CAT_PROFILES_KEY)
					const parsedCats = typeof cats === 'string' ? JSON.parse(cats || '[]') : cats
					if (Array.isArray(parsedCats) && parsedCats.length) this.catCount = parsedCats.length
				} catch (error) {}
				try {
					const preferences = uni.getStorageSync(FOODCAST_PREFERENCES_KEY) || {}
					this.foodcastModeLabel = preferences.mode === 'natural' ? '自然慢剪' : '萌脸快剪'
				} catch (error) {}
				try {
					const storedWifiOnly = uni.getStorageSync(WIFI_ONLY_UPLOAD_KEY)
					if (storedWifiOnly !== '') this.wifiOnly = !!storedWifiOnly
				} catch (error) {}
			},
			goTo(url) {
				uni.navigateTo({ url })
			},
			showUnavailable(label) {
				uni.showToast({ title: `${label}暂未接入`, icon: 'none' })
			},
			toggleWifiOnly(event) {
				this.wifiOnly = !!(event && event.detail && event.detail.value)
				uni.setStorageSync(WIFI_ONLY_UPLOAD_KEY, this.wifiOnly)
			},
			logout() {
				uni.showModal({
					title: '退出登录',
					content: '确定要退出当前账号吗？',
					success: (res) => {
						if (res.confirm) {
							clearAppSession()
							uni.reLaunch({ url: '/pages/login/index' })
						}
					}
				})
			}
		}
	}
</script>

<style>
	.settings-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.settings-content { padding: 32rpx 48rpx calc(52rpx + env(safe-area-inset-bottom)); }
	.account-summary { display: flex; align-items: center; gap: 28rpx; min-height: 120rpx; }
	.account-avatar { width: 112rpx; height: 112rpx; flex: none; border-radius: 50%; background: #F1F1EF; }
	.account-copy { min-width: 0; flex: 1; }
	.account-name { display: block; overflow: hidden; color: #141414; font-size: 40rpx; line-height: 52rpx; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
	.account-meta { display: block; margin-top: 4rpx; color: #989893; font-size: 25rpx; line-height: 36rpx; }
	.section-divider { height: 2rpx; margin-top: 32rpx; background: #E8E8E5; }
	.section-label { display: block; margin-top: 24rpx; color: #989893; font-size: 22rpx; line-height: 32rpx; font-weight: 600; letter-spacing: 2rpx; }
	.settings-section { margin-top: 4rpx; }
	.settings-row { display: flex; align-items: center; gap: 20rpx; min-height: 112rpx; box-sizing: border-box; border-bottom: 2rpx solid #EFEFED; }
	.settings-row-tall { min-height: 132rpx; }
	.row-copy { min-width: 0; flex: 1; }
	.row-title { min-width: 0; flex: 1; color: #141414; font-size: 29rpx; line-height: 42rpx; }
	.row-copy .row-title { display: block; }
	.row-description { display: block; margin-top: 2rpx; color: #989893; font-size: 22rpx; line-height: 32rpx; }
	.row-meta { max-width: 52%; overflow: hidden; color: #989893; font-size: 23rpx; line-height: 34rpx; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
	.row-arrow { flex: none; color: #C4C4C0; font-size: 42rpx; line-height: 1; font-weight: 300; }
	.wifi-upload-switch { flex: none; transform: scale(.82); transform-origin: right center; }
	.logout-button { width: 100%; height: 96rpx; padding: 0; margin: 32rpx 0 0; border: 0; border-radius: 48rpx; background: #F1F1EF; color: #9A4A40; font-size: 27rpx; line-height: 96rpx; text-align: center; font-weight: 600; }
	.logout-button::after { border: 0; }
	.logout-note { display: block; margin-top: 16rpx; color: #B4B4B0; font-size: 21rpx; line-height: 32rpx; text-align: center; }
</style>
