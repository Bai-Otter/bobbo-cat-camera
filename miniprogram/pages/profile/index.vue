<template>
	<view class="profile-page" :style="{ paddingTop: statusBarHeight + 'px' }">
		<view class="family-identity" :style="{ paddingRight: headerRightInset + 'px', minHeight: headerHeight + 'px' }">
			<button class="avatar-button" open-type="chooseAvatar" @chooseavatar="onChooseAvatar">
				<image class="family-avatar" :src="userAvatar" mode="aspectFill" @error="onAvatarError" />
				<view class="avatar-edit-dot"><cat-icon name="camera" :size="18" color="#FFFFFF" /></view>
			</button>
			<view class="family-copy">
				<view class="family-name-line">
					<input
						class="nickname-input"
						type="nickname"
						v-model="userName"
						placeholder="设置昵称"
						maxlength="20"
						@blur="onNicknameBlur"
						@confirm="onNicknameBlur"
					/>
					<text class="family-suffix">的家</text>
				</view>
			</view>
		</view>

		<view class="divider"></view>

		<view class="profile-stats">
			<view class="stat-column" @click="goCatArchive">
				<text class="stat-value">{{ cats.length }}</text>
				<text class="stat-label">只猫咪</text>
			</view>
			<view class="stat-column" @click="goDeviceList">
				<text class="stat-value">{{ deviceCount }}</text>
				<text class="stat-label">台设备</text>
			</view>
			<view class="stat-column" @click="goFoodcast">
				<text class="stat-value">{{ foodcastCountDisplay }}</text>
				<text class="stat-label">条吃播</text>
			</view>
		</view>

		<view class="divider"></view>

		<view class="section-heading" @click="goCatArchive">
			<view>
				<text class="section-title">猫咪档案</text>
			</view>
			<text class="manage-link">管理档案</text>
		</view>
		<scroll-view class="cat-strip" scroll-x :show-scrollbar="false">
			<view class="cat-strip-content">
				<view v-for="cat in cats" :key="profileKey(cat)" class="cat-item" @click="goCatArchive">
					<image class="cat-avatar" :src="cat.avatar || defaultAvatar" mode="aspectFill" />
					<text class="cat-name">{{ cat.name }}</text>
				</view>
				<view class="cat-item add-cat-item" @click="goCatArchive">
					<view class="add-cat-circle"><text>＋</text></view>
					<text class="cat-name">添加</text>
				</view>
			</view>
		</scroll-view>

		<view class="divider section-divider"></view>

		<view class="setting-list">
			<view class="setting-row" @click="goDeviceList">
				<view class="setting-icon-wrap"><cat-icon name="settings-devices" :size="42" color="#141414" :stroke="1.7" /></view>
				<view class="setting-copy">
					<text class="setting-title">设备管理</text>
				</view>
				<view class="row-chevron"><cat-icon name="chevron-right" :size="30" color="#B4B4B0" :stroke="2" /></view>
			</view>
			<view class="setting-row" @click="goNotificationSettings">
				<view class="setting-icon-wrap"><cat-icon name="settings-notifications" :size="42" color="#141414" :stroke="1.7" /></view>
				<view class="setting-copy">
					<text class="setting-title">通知设置</text>
				</view>
				<view class="row-chevron"><cat-icon name="chevron-right" :size="30" color="#B4B4B0" :stroke="2" /></view>
			</view>
			<view class="setting-row" @click="foodcastPreferences">
				<view class="setting-icon-wrap"><cat-icon name="settings-tune" :size="42" color="#141414" :stroke="1.7" /></view>
				<view class="setting-copy">
					<text class="setting-title">吃播偏好</text>
				</view>
				<view class="row-chevron"><cat-icon name="chevron-right" :size="30" color="#B4B4B0" :stroke="2" /></view>
			</view>
			<view class="setting-row" @click="shareDevice">
				<view class="setting-icon-wrap"><cat-icon name="settings-share" :size="42" color="#141414" :stroke="1.7" /></view>
				<view class="setting-copy">
					<text class="setting-title">分享设备</text>
				</view>
				<view class="row-chevron"><cat-icon name="chevron-right" :size="30" color="#B4B4B0" :stroke="2" /></view>
			</view>
			<view class="setting-row account-settings-row" @click="goSettings">
				<view class="setting-icon-wrap"><cat-icon name="settings-account" :size="42" color="#141414" :stroke="1.7" /></view>
				<view class="setting-copy">
					<text class="setting-title">账号设置</text>
				</view>
				<view class="row-chevron"><cat-icon name="chevron-right" :size="30" color="#B4B4B0" :stroke="2" /></view>
			</view>
		</view>

		<app-tab-bar current="profile" />
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	import appTabBar from '@/components/app-tab-bar/app-tab-bar.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { refreshOwnedDevices } = require('@/utils/ownedDeviceCache.js')
	const { ensureAppSession, readAppAuthState, readUserProfile, writeUserProfile } = require('@/utils/appAuth.js')
	const { DEFAULT_CAT_AVATAR, catProfileKey, readCatProfiles, refreshCatProfiles } = require('@/utils/catProfiles.js')
	const { readPageData, writePageData } = require('@/utils/pageDataCache.js')
	const { isPersistedUserAvatar, preferUserAvatar, uploadUserAvatar } = require('@/utils/userAvatar.js')

	const DEFAULT_AVATAR = DEFAULT_CAT_AVATAR
	const LEGACY_DEFAULT_AVATARS = [
		'/static/images/cat-avatar.svg',
		'/static/images/user-avatar.svg'
	]
	const DEFAULT_NAME = '微信用户'

	export default {
		components: { catIcon, appTabBar },
		data() {
			return {
				userName: DEFAULT_NAME,
				userAvatar: DEFAULT_AVATAR,
				defaultAvatar: DEFAULT_AVATAR,
				deviceCount: 0,
				coCreatorNo: 1,
				feedingDetectionEnabled: false,
				pushPlusConfigured: false,
				statusBarHeight: 24,
				headerHeight: 52,
				headerRightInset: 0,
				cats: [],
				foodcastCount: null,
				avatarRepairing: false
			}
		},
		computed: {
			foodcastCountDisplay() {
				return Number.isFinite(this.foodcastCount) ? String(this.foodcastCount) : '—'
			}
		},
		onShow() {
			this.setNavigationMetrics()
			if (!ensureAppSession({ message: '请先登录' })) return
			const cached = readPageData('profile:dashboard', { uniApi: uni, tags: ['profile', 'cats', 'devices', 'foodcasts'] })
			if (cached) {
				Object.assign(this, cached)
				this.reconcileCachedDashboard()
				return
			}
			this.loadDashboard()
		},
		methods: {
			writeDashboardCache() {
				return writePageData('profile:dashboard', {
					userName: this.userName,
					userAvatar: this.userAvatar,
					deviceCount: this.deviceCount,
					coCreatorNo: this.coCreatorNo,
					feedingDetectionEnabled: this.feedingDetectionEnabled,
					pushPlusConfigured: this.pushPlusConfigured,
					cats: this.cats,
					foodcastCount: this.foodcastCount
				}, { uniApi: uni, tags: ['profile', 'cats', 'devices', 'foodcasts'] })
			},
			async reconcileCachedDashboard() {
				const prof = readUserProfile()
				if (prof.nickname) this.userName = prof.nickname
				if (prof.avatar && !LEGACY_DEFAULT_AVATARS.includes(prof.avatar)) this.userAvatar = prof.avatar
				await Promise.allSettled([
					this.refreshFromCloud(),
					this.fetchDeviceCount(),
					this.repairLocalAvatar(prof.avatar)
				])
				this.writeDashboardCache()
			},
			async loadDashboard() {
				await Promise.allSettled([this.loadCatProfiles(), this.loadUser(), this.loadFoodcastStats()])
				this.writeDashboardCache()
			},
			profileKey(cat) {
				return catProfileKey(cat)
			},
			setNavigationMetrics() {
				const runtime = typeof uni !== 'undefined' ? uni : null
				let systemInfo = {}
				try {
					if (runtime && typeof runtime.getWindowInfo === 'function') {
						systemInfo = runtime.getWindowInfo() || {}
					} else if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
						systemInfo = wx.getWindowInfo() || {}
					} else if (runtime && typeof runtime.getSystemInfoSync === 'function') {
						systemInfo = runtime.getSystemInfoSync() || {}
					} else if (typeof wx !== 'undefined' && typeof wx.getSystemInfoSync === 'function') {
						systemInfo = wx.getSystemInfoSync() || {}
					}
				} catch (error) {
					systemInfo = {}
				}

				this.statusBarHeight = Number(systemInfo.statusBarHeight) || 24
				this.headerHeight = 52
				this.headerRightInset = 0
				const readMenuButton = runtime && typeof runtime.getMenuButtonBoundingClientRect === 'function'
					? () => runtime.getMenuButtonBoundingClientRect()
					: typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function'
						? () => wx.getMenuButtonBoundingClientRect()
						: null
				if (!readMenuButton) return

				try {
					const menuButton = readMenuButton() || {}
					const windowWidth = Number(systemInfo.windowWidth)
					const menuTop = Number(menuButton.top)
					const menuLeft = Number(menuButton.left)
					const menuHeight = Number(menuButton.height)
					if (!windowWidth || !menuLeft || !menuHeight || !Number.isFinite(menuTop)) return

					const verticalGap = Math.max(0, menuTop - this.statusBarHeight)
					this.headerHeight = Math.max(52, verticalGap * 2 + menuHeight)
					const occupiedRight = windowWidth - menuLeft + 8
					this.headerRightInset = Math.max(0, occupiedRight - 24)
				} catch (error) {
					this.headerHeight = 52
					this.headerRightInset = 0
				}
			},
			async loadCatProfiles() {
				this.cats = readCatProfiles(uni)
				try {
					const payload = await callBackend('/api/devices')
					const result = await refreshCatProfiles({ storage: uni, callBackend, accountId: readAppAuthState(uni).openid, devices: payload.devices || [] })
					this.cats = result.cats
				} catch (error) { console.log('[profile] 猫咪档案刷新失败', error) }
			},
			async loadFoodcastStats() {
				this.foodcastCount = null
				try {
					const result = await callBackend('/api/foodcasts/stats')
					const count = Number(result && result.stats && result.stats.availableCount)
					this.foodcastCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
				} catch (error) {
					console.log('[profile] 吃播统计刷新失败', error)
				}
			},
			mergeUserProfile(patch) {
				const current = readUserProfile()
				const next = Object.assign({}, current, patch)
				if (Object.prototype.hasOwnProperty.call(patch || {}, 'avatar')) {
					next.avatar = preferUserAvatar(current.avatar, patch.avatar)
				}
				writeUserProfile(next)
				return next
			},
			async loadUser() {
				const prof = readUserProfile()
				this.userName = prof.nickname || DEFAULT_NAME
				this.userAvatar = prof.avatar && !LEGACY_DEFAULT_AVATARS.includes(prof.avatar)
					? prof.avatar
					: DEFAULT_AVATAR
				this.coCreatorNo = this.getCoCreatorNo(prof.openid || prof.backendLoginAt || '')
				await Promise.allSettled([
					this.loadFeedingDetectionSetting(),
					this.refreshFromCloud(),
					this.fetchDeviceCount(),
					this.repairLocalAvatar(prof.avatar)
				])
			},
			getCoCreatorNo(seed) {
				const raw = String(seed || Date.now())
				let sum = 0
				for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i) * (i + 1)
				return (sum % 50) + 1
			},
			async loadFeedingDetectionSetting() {
				try {
					const result = await callBackend('/api/feed-analysis/status')
					const settings = result.settings || {}
					this.feedingDetectionEnabled = settings.feedingDetectionEnabled !== undefined
						? !!settings.feedingDetectionEnabled
						: !!settings.analysisEnabled && !!settings.notifyEnabled
					const notificationProvider = result.notificationProvider || {}
					this.pushPlusConfigured = !!notificationProvider.configured
				} catch (error) {
					console.log('[profile] feeding detection setting failed', error)
				}
			},
			refreshFromCloud() {
				// #ifdef MP-WEIXIN
				const prof = readUserProfile()
				if (!prof || !prof.cloudOk) {
					return callBackend('/api/profile')
						.then((result) => {
							const profile = (result && result.profile) || {}
							const merged = this.mergeUserProfile(profile)
							if (merged.nickname) this.userName = merged.nickname
							if (merged.avatar && !LEGACY_DEFAULT_AVATARS.includes(merged.avatar)) this.userAvatar = merged.avatar
						})
						.catch((error) => console.log('[profile] 本机 profile 刷新失败', error))
					return
				}
				if (!wx.cloud) return Promise.resolve()
				return new Promise((resolve) => wx.cloud.callFunction({
					name: 'login',
					data: {},
					success: (res) => {
						const r = (res && res.result) || {}
						if (r.ok && r.profile) {
							const avatar = isPersistedUserAvatar(r.profile.avatar) && !LEGACY_DEFAULT_AVATARS.includes(r.profile.avatar)
								? r.profile.avatar
								: ''
							const nickname = r.profile.nickname || ''
							if (avatar) this.userAvatar = avatar
							if (nickname) this.userName = nickname
							const patch = { nickname }
							if (avatar) patch.avatar = avatar
							this.mergeUserProfile(patch)
						}
						resolve()
					},
					fail: (err) => { console.log('[profile] cloud profile refresh failed', err); resolve() }
				}))
				// #endif
			},
			async fetchDeviceCount() {
				try {
					const refreshed = await refreshOwnedDevices(async () => {
						const result = await callBackend('/api/devices')
						return Array.isArray(result.devices) ? result.devices : []
					}, uni)
					this.deviceCount = refreshed.devices.length
				} catch (error) {
					console.log('[profile] device count failed', error)
					this.deviceCount = 0
				}
			},
			async repairLocalAvatar(avatar) {
				const localAvatar = String(avatar || '').trim()
				if (!localAvatar || isPersistedUserAvatar(localAvatar) || LEGACY_DEFAULT_AVATARS.includes(localAvatar) || this.avatarRepairing) return ''
				this.avatarRepairing = true
				try {
					const remoteAvatar = await uploadUserAvatar({ filePath: localAvatar, wxApi: wx, uniApi: uni })
					await this.saveRemoteAvatar(remoteAvatar, { toast: false })
					return remoteAvatar
				} catch (error) {
					console.warn('[profile] local avatar migration failed', String(error && error.message || error))
					return ''
				} finally {
					this.avatarRepairing = false
				}
			},
			async saveRemoteAvatar(remoteAvatar, options = {}) {
				this.userAvatar = remoteAvatar
				this.mergeUserProfile({ avatar: remoteAvatar })
				const result = await callBackend('/api/profile', { method: 'PATCH', data: { avatar: remoteAvatar } })
				const saved = this.mergeUserProfile((result && result.profile) || { avatar: remoteAvatar })
				this.userAvatar = saved.avatar || remoteAvatar
				this.writeDashboardCache()
				if (options.toast !== false) uni.showToast({ title: '头像已更新', icon: 'success', duration: 1000 })
				return this.userAvatar
			},
			async persistSelectedAvatar(localPath) {
				this.userAvatar = localPath
				this.mergeUserProfile({ avatar: localPath })
				try {
					const remoteAvatar = await uploadUserAvatar({ filePath: localPath, wxApi: wx, uniApi: uni })
					await this.saveRemoteAvatar(remoteAvatar)
				} catch (error) {
					console.warn('[profile] avatar upload failed', String(error && error.message || error))
					uni.showToast({ title: '头像上传失败，请重试', icon: 'none' })
				}
			},
			onAvatarError() {
				this.userAvatar = DEFAULT_AVATAR
			},
			onChooseAvatar(e) {
				const tempPath = e && e.detail && e.detail.avatarUrl
				if (!tempPath) return
				this.userAvatar = tempPath
				try {
					const fs = wx.getFileSystemManager()
					fs.saveFile({
						tempFilePath: tempPath,
						success: (r) => this.persistSelectedAvatar(r.savedFilePath),
						fail: () => this.persistSelectedAvatar(tempPath)
					})
				} catch (error) {
					this.persistSelectedAvatar(tempPath)
				}
			},
			onNicknameBlur(e) {
				const val = (e && e.detail && e.detail.value) || this.userName
				const name = String(val).trim()
				if (!name) return
				this.userName = name
				this.saveProfile({ nickname: name })
			},
			saveProfile(patch) {
				this.mergeUserProfile(patch)
				// #ifdef MP-WEIXIN
				const prof = readUserProfile()
				if (prof && prof.cloudOk && wx.cloud) {
					wx.cloud.callFunction({
						name: 'updateProfile',
						data: patch,
						fail: (err) => console.log('[profile] updateProfile failed, saved locally', err)
					})
				} else {
					callBackend('/api/profile', {
						method: 'PATCH',
						data: patch
					}).catch((error) => console.log('[profile] 本机 profile 保存失败，已暂存本地', error))
				}
				// #endif
				uni.showToast({ title: '已更新', icon: 'success', duration: 1000 })
			},
			goCatArchive() { uni.navigateTo({ url: '/pages/profile/cats' }) },
			goSettings() { uni.navigateTo({ url: '/pages/profile/settings' }) },
			goDeviceList() { uni.navigateTo({ url: '/pages/device/index' }) },
			goNotificationSettings() { uni.navigateTo({ url: '/pages/profile/notifications' }) },
			goFoodcast() { uni.reLaunch({ url: '/pages/clips/index?library=1' }) },
			foodcastPreferences() { uni.navigateTo({ url: '/pages/profile/foodcast-preferences' }) },
			shareDevice() { uni.navigateTo({ url: '/pages/profile/share-device' }) }
		}
	}
</script>

<style>
	.profile-page {
		min-height: 100vh;
		box-sizing: border-box;
		padding: 12rpx 48rpx 220rpx;
		background: #FBFBFA;
		color: #141414;
	}
	.family-identity { display: flex; align-items: center; gap: 28rpx; padding: 16rpx 0 34rpx; }
	.avatar-button { position: relative; flex: 0 0 120rpx; width: 120rpx; height: 120rpx; padding: 0; margin: 0; border: 0; border-radius: 60rpx; background: #EFEEEC; line-height: 1; }
	.avatar-button::after { border: 0; }
	.family-avatar { display: block; width: 120rpx; height: 120rpx; border-radius: 60rpx; background: #EFEEEC; }
	.avatar-edit-dot { position: absolute; right: 0; bottom: 0; display: flex; align-items: center; justify-content: center; width: 34rpx; height: 34rpx; border: 4rpx solid #FBFBFA; border-radius: 50%; background: #141414; }
	.family-copy { min-width: 0; flex: 1; }
	.family-name-line { display: flex; align-items: center; min-width: 0; }
	.nickname-input { min-width: 80rpx; max-width: 260rpx; height: 58rpx; padding: 0; font-size: 48rpx; line-height: 58rpx; font-weight: 700; color: #141414; }
	.family-suffix { flex: 0 0 auto; font-size: 48rpx; line-height: 58rpx; font-weight: 700; }
	.divider { height: 2rpx; background: #E8E8E5; }
	.profile-stats { display: flex; padding: 34rpx 0 32rpx; }
	.stat-column { position: relative; display: flex; flex: 1; min-width: 0; align-items: center; flex-direction: column; }
	.stat-column + .stat-column::before { position: absolute; top: 4rpx; bottom: 4rpx; left: 0; width: 2rpx; background: #E8E8E5; content: ''; }
	.stat-value { font-size: 48rpx; line-height: 58rpx; font-weight: 700; }
	.stat-label { color: #5A5A56; font-size: 24rpx; line-height: 36rpx; }
	.section-heading { display: flex; align-items: flex-end; justify-content: space-between; padding: 32rpx 0 24rpx; }
	.section-title { display: block; font-size: 32rpx; line-height: 44rpx; font-weight: 700; }
	.manage-link { padding-bottom: 4rpx; color: #141414; font-size: 25rpx; font-weight: 600; }
	.cat-strip { width: 100%; white-space: nowrap; }
	.cat-strip-content { display: inline-flex; align-items: flex-start; gap: 30rpx; min-width: 100%; }
	.cat-item { display: inline-flex; width: 116rpx; align-items: center; flex-direction: column; }
	.cat-avatar, .add-cat-circle { width: 116rpx; height: 116rpx; border-radius: 58rpx; }
	.cat-avatar { display: block; background: #EFEEEC; }
	.add-cat-circle { display: flex; box-sizing: border-box; align-items: center; justify-content: center; border: 2rpx dashed #B4B4B0; color: #5A5A56; }
	.add-cat-circle text { font-size: 42rpx; line-height: 1; font-weight: 300; }
	.cat-name { max-width: 116rpx; margin-top: 10rpx; overflow: hidden; color: #141414; font-size: 24rpx; line-height: 34rpx; text-overflow: ellipsis; white-space: nowrap; }
	.section-divider { margin-top: 30rpx; }
	.setting-list { width: 100%; }
	.setting-row { display: flex; align-items: center; min-height: 96rpx; border-bottom: 2rpx solid #EFEFED; }
	.setting-icon-wrap { display: flex; flex: 0 0 44rpx; width: 44rpx; height: 44rpx; align-items: center; justify-content: center; }
	.setting-copy { min-width: 0; flex: 1; margin-left: 22rpx; }
	.setting-title { display: block; color: #141414; font-size: 29rpx; line-height: 42rpx; font-weight: 600; }
	.row-chevron { display: flex; flex: 0 0 32rpx; width: 32rpx; height: 32rpx; margin-left: 14rpx; align-items: center; justify-content: center; }
</style>
