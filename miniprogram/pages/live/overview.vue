<template>
	<view class="live-overview-page" :style="{ paddingTop: statusBarHeight + 'px' }">
		<view class="page-header" :style="{ paddingRight: headerRightInset + 'px', minHeight: headerHeight + 'px' }">
			<text class="page-title">实时</text>
			<view class="online-summary">
				<view class="online-dot"></view>
				<text>{{onlineCount}} 台在线</text>
			</view>
		</view>

		<view class="loading-state" v-if="loading && devices.length === 0">
			<text>正在读取设备...</text>
		</view>

		<view class="recent-device-hero" v-else-if="heroDevice" @click="goLive(heroDevice)">
			<image v-if="heroDevice.coverUrl" class="hero-image" :src="heroDevice.coverUrl" mode="aspectFill" />
			<view v-else class="hero-placeholder"><cat-icon name="camera" :size="112" color="#989893" /></view>
			<view class="live-badge">
				<view class="live-dot" :class="{offline: heroDevice._statusState !== 'online'}"></view>
				<text>{{deviceStatusLabel(heroDevice, true)}}</text>
			</view>
			<text class="quality-badge">{{qualityPreference === '流畅' ? '标清' : '1080P'}}</text>
			<view class="hero-action">
				<text>查看实时</text>
			</view>
		</view>
		<view class="hero-caption" v-if="heroDevice">
			<text class="hero-name">{{heroDevice.nickname || '摄像头'}}</text>
		</view>

		<view class="empty-state" v-else>
			<cat-icon name="camera" :size="76" color="#989893" />
			<text class="empty-title">还没有绑定设备</text>
			<text class="empty-copy">添加摄像头后即可查看实时状态与录像。</text>
			<view class="empty-action" @click="goAddDevice"><text>添加设备</text></view>
		</view>

		<view class="section device-section" v-if="devices.length > 1">
			<text class="section-title">其他设备</text>
			<view class="device-list">
				<view class="device-row" v-for="item in additionalDevices" :key="item.sn" @click="goLive(item)">
					<view class="online-dot" :class="{offline: item._statusState !== 'online'}"></view>
					<text class="device-name">{{item.nickname || '摄像头'}}</text>
					<text class="device-status">{{deviceStatusLabel(item)}}</text>
					<text class="device-arrow">›</text>
				</view>
			</view>
		</view>

		<view class="section quick-section">
			<view class="quick-pills">
				<view class="quick-item" @click="goNotifications">
					<text>通知 · 管理</text>
				</view>
				<view class="quick-item" @click="chooseQuality">
					<text>画质 · {{qualityPreference}}</text>
				</view>
				<view class="quick-item" @click="goDeviceList">
					<text>设备状态</text>
				</view>
			</view>
		</view>

		<view class="retry-row" v-if="error" @click="loadDevices"><text>{{error}}，点击重试</text></view>
		<view class="bottom-safe"></view>
		<app-tab-bar current="live" />
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	import appTabBar from '@/components/app-tab-bar/app-tab-bar.vue'
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { callDemoData } = require('@/utils/demoCloud.js')
	const { buildOwnedDeviceCards } = require('@/utils/deviceMediaState.js')
	const { readOwnedDevices, refreshOwnedDevices, replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')
	const { fetchAccessibleDeviceStatuses, mergeAccessibleDeviceStatuses } = require('@/utils/accessibleDeviceStatus.js')
	const { ensureSharedLiveAccess, retainAccessibleSharedDevices } = require('@/utils/sharedLiveAccess.js')
	const STATUS_REFRESH_MS = 60 * 1000

	export default {
		components: { catIcon, appTabBar },
		data() {
			return {
				devices: [],
				loading: false,
				error: '',
				statusBarHeight: 24,
				headerHeight: 52,
				headerRightInset: 24,
				qualityPreference: '高清',
				statusRefreshTimer: null
			}
		},
		computed: {
			heroDevice() {
				const lastSn = uni.getStorageSync('lastViewedDeviceSn') || ''
				return this.devices.find((item) => item.sn === lastSn) || this.devices[0] || null
			},
			additionalDevices() {
				if (!this.heroDevice) return []
				return this.devices.filter((item) => item.sn !== this.heroDevice.sn)
			},
			onlineCount() {
				return this.devices.filter((item) => item._online).length
			}
		},
		onShow() {
			this.setNavigationMetrics()
			if (!ensureAppSession({ message: '请先登录' })) return
			this.qualityPreference = uni.getStorageSync('liveQualityPreference') || '高清'
			if (this.restoreCachedDevices()) {
				this.prewarmSharedAccess(this.devices)
				this.startStatusRefresh()
				this.refreshStatuses()
			}
			this.loadDevices()
		},
		onHide() {
			this.stopStatusRefresh()
		},
		onUnload() {
			this.stopStatusRefresh()
		},
		methods: {
			deviceStatusLabel(item, hero = false) {
				if (item && item._statusState === 'online') return hero ? '直播中' : '在线'
				if (item && item._statusState === 'offline') return hero ? '当前离线' : '离线'
				if (item && item._statusState === 'error') return '状态异常'
				return '状态检测中'
			},
			restoreCachedDevices() {
				const cached = readOwnedDevices(uni)
				if (cached.length === 0) return false
				this.devices = buildOwnedDeviceCards({ devices: cached })
				return true
			},
			setNavigationMetrics() {
				const runtime = typeof uni !== 'undefined' ? uni : null
				let systemInfo = {}
				try {
					if (runtime && typeof runtime.getSystemInfoSync === 'function') {
						systemInfo = runtime.getSystemInfoSync() || {}
					} else if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
						systemInfo = wx.getWindowInfo() || {}
					}
				} catch (error) {
					systemInfo = {}
				}

				this.statusBarHeight = Number(systemInfo.statusBarHeight) || 24
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
					this.headerRightInset = Math.max(24, windowWidth - menuLeft + 8)
				} catch (error) {
					this.headerHeight = 52
					this.headerRightInset = 24
				}
			},
			stopStatusRefresh() {
				if (this.statusRefreshTimer) clearInterval(this.statusRefreshTimer)
				this.statusRefreshTimer = null
			},
			startStatusRefresh() {
				this.stopStatusRefresh()
				this.statusRefreshTimer = setInterval(() => this.refreshStatuses(), STATUS_REFRESH_MS)
			},
			mergeDeviceRows(rows = []) {
				const nextBySn = new Map(rows.map((item) => [item.sn, item]))
				this.devices = this.devices.map((item) => nextBySn.get(item.sn) || item)
				replaceOwnedDevices(this.devices, uni)
			},
			async refreshStatuses() {
				const devices = this.devices.slice()
				await Promise.allSettled(devices.map(async (device) => {
					const statuses = await fetchAccessibleDeviceStatuses([device], callBackend)
					this.mergeDeviceRows(mergeAccessibleDeviceStatuses([device], statuses))
				}))
			},
			async refreshCovers(devices) {
				const sns = devices.map((item) => item.sn).filter(Boolean)
				if (sns.length === 0) return
				const coverResult = await callDemoData('getDeviceCovers', { sns })
				if (!coverResult || !coverResult.ok) return
				const coversBySn = coverResult.coversBySn || {}
				this.mergeDeviceRows(buildOwnedDeviceCards({ devices: this.devices, coversBySn }))
			},
			async refreshHeroCoverIfNeeded() {
				const hero = this.heroDevice
				if (!hero || hero._statusState !== 'online' || (hero.coverUrl && !hero.isCoverStale)) return
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(hero.sn) + '/live-snapshot', {
						method: 'POST',
						data: { stream: '1' }
					})
					if (!result || !result.coverUrl) return
					this.mergeDeviceRows(buildOwnedDeviceCards({
						devices: this.devices,
						coversBySn: {
							[hero.sn]: { coverUrl: result.coverUrl, updatedAt: result.capturedAt }
						}
					}))
				} catch (error) {
					console.warn('[live-overview] background hero cover refresh failed', { sn: hero.sn })
				}
			},
			prewarmSharedAccess(devices) {
				retainAccessibleSharedDevices(devices)
				for (const device of devices) {
					if (device.role !== 'member') continue
					ensureSharedLiveAccess({ device, callBackend }).catch((error) => {
						console.warn('[live-overview] shared access prewarm failed', { sn: device.sn, code: error && error.code })
					})
				}
			},
			async loadDevices() {
				if (this.loading) return
				this.loading = true
				this.error = ''
				try {
					const refreshed = await refreshOwnedDevices(async () => {
						const result = await callBackend('/api/devices')
						return Array.isArray(result.devices) ? result.devices : []
					}, uni)
					const owned = refreshed.devices
					if (!refreshed.refreshed) {
						console.warn('[live-overview] backend device refresh failed, using cache', refreshed.error)
					}
					console.log('[live-overview] owned devices resolved', {
						source: refreshed.refreshed ? 'backend' : 'cache',
						devices: owned.map((item) => ({ sn: item.sn, active: item.active })),
						lastViewedSn: uni.getStorageSync('lastViewedDeviceSn') || ''
					})
					const cards = buildOwnedDeviceCards({ devices: owned })
					this.devices = cards
					replaceOwnedDevices(cards, uni)
					this.prewarmSharedAccess(cards)
					this.startStatusRefresh()
					await Promise.allSettled([
						this.refreshCovers(cards),
						this.refreshStatuses()
					])
					this.refreshHeroCoverIfNeeded()
				} catch (error) {
					this.error = getBackendErrorMessage(error, '设备加载失败')
				} finally {
					this.loading = false
				}
			},
			devicePayload(item) {
				return {
					online: !!item._online,
					sn: item.sn,
					token: item.role === 'member' ? '' : item.token || item.deviceToken || '',
					username: item.username || 'admin',
					ip: item.ip || item.devIp || item.ipAddress || '',
					port: item.port || '',
					nickname: item.nickname || '摄像头',
					coverUrl: item.coverUrl || '',
					role: item.role || 'owner',
					primaryCatId: item.primaryCatId || '',
					primaryCatRef: item.primaryCatRef || '',
					permissions: item.permissions || [],
					liveDiagnosticsEnabled: item.liveDiagnosticsEnabled === true
				}
			},
			goLive(item) {
				if (!item || !item.sn) return
				uni.setStorageSync('lastViewedDeviceSn', item.sn)
				uni.navigateTo({ url: '/pages/live/index?device=' + encodeURIComponent(JSON.stringify(this.devicePayload(item))) })
			},
			goNotifications() { uni.navigateTo({ url: '/pages/profile/notifications' }) },
			goDeviceList() { uni.navigateTo({ url: '/pages/device/index' }) },
			goAddDevice() { uni.navigateTo({ url: '/pages/bind/addDevice' }) },
			chooseQuality() {
				uni.showActionSheet({
					itemList: ['高清', '流畅'],
					success: ({ tapIndex }) => {
						this.qualityPreference = tapIndex === 1 ? '流畅' : '高清'
						uni.setStorageSync('liveQualityPreference', this.qualityPreference)
					}
				})
			}
		}
	}
</script>

<style>
	.live-overview-page { min-height: 100vh; box-sizing: border-box; background: #FBFBFA; color: #141414; }
	.page-header { min-height: 104rpx; padding: 20rpx 48rpx 16rpx; box-sizing: border-box; display: flex; align-items: flex-end; justify-content: space-between; }
	.page-title { flex: none; font-size: 64rpx; line-height: 1.2; font-weight: 700; white-space: nowrap; }
	.online-summary { flex: none; padding-bottom: 10rpx; display: flex; align-items: center; gap: 12rpx; color: #989893; font-size: 25rpx; white-space: nowrap; }
	.online-summary text { white-space: nowrap; }
	.loading-state { height: 574rpx; display: flex; align-items: center; justify-content: center; color: #989893; font-size: 26rpx; }
	.recent-device-hero { position: relative; width: 100%; height: 574rpx; overflow: hidden; background: #F1F1EF; }
	.hero-image { width: 100%; height: 100%; }
	.hero-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #F1F1EF; }
	.live-badge, .quality-badge, .hero-action { position: absolute; border: 2rpx solid rgba(255,255,255,.18); background: rgba(11,11,12,.72); color: #FFFFFF; }
	.live-badge { top: 28rpx; left: 48rpx; height: 48rpx; padding: 0 22rpx; border-radius: 24rpx; display: flex; align-items: center; gap: 12rpx; font-size: 23rpx; font-weight: 600; }
	.quality-badge { top: 28rpx; right: 48rpx; height: 48rpx; padding: 0 22rpx; border-radius: 24rpx; line-height: 48rpx; font-size: 22rpx; }
	.hero-action { right: 48rpx; bottom: 28rpx; height: 64rpx; padding: 0 34rpx; border-radius: 32rpx; display: flex; align-items: center; font-size: 27rpx; font-weight: 600; }
	.live-dot { width: 12rpx; height: 12rpx; border-radius: 50%; background: #3DDC74; }
	.live-dot.offline { background: #C4C4C0; }
	.hero-caption { min-height: 84rpx; padding: 26rpx 48rpx 10rpx; box-sizing: border-box; display: flex; align-items: center; }
	.hero-name { display: block; font-size: 40rpx; line-height: 1.25; font-weight: 700; }
	.online-dot { width: 12rpx; height: 12rpx; border-radius: 50%; flex: none; background: #2FA35C; }
	.online-dot.offline { background: #C4C4C0; }
	.empty-state { height: 490rpx; margin-top: 14rpx; padding: 0 48rpx; border-top: 2rpx solid #E8E8E5; border-bottom: 2rpx solid #E8E8E5; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.empty-title { margin-top: 20rpx; font-size: 30rpx; font-weight: 600; }
	.empty-copy { margin-top: 10rpx; color: #989893; font-size: 24rpx; text-align: center; }
	.empty-action { margin-top: 28rpx; height: 70rpx; padding: 0 32rpx; border-radius: 35rpx; background: #141414; color: #FFFFFF; display: flex; align-items: center; font-size: 26rpx; }
	.section { margin: 28rpx 48rpx 0; padding-top: 22rpx; border-top: 2rpx solid #E8E8E5; }
	.section-title { display: block; margin-bottom: 4rpx; font-size: 28rpx; font-weight: 600; }
	.device-list { width: 100%; }
	.device-row { height: 104rpx; display: flex; align-items: center; gap: 20rpx; border-bottom: 2rpx solid #EFEFED; }
	.device-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 30rpx; font-weight: 500; }
	.device-status { color: #989893; font-size: 25rpx; }
	.device-arrow { color: #C4C4C0; font-size: 36rpx; }
	.quick-section { margin-top: 28rpx; }
	.quick-pills { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16rpx; }
	.quick-item { min-width: 0; height: 76rpx; padding: 0 10rpx; border-radius: 38rpx; background: #F1F1EF; display: flex; align-items: center; justify-content: center; color: #141414; font-size: 24rpx; text-align: center; }
	.retry-row { padding: 28rpx 48rpx; color: #141414; text-align: center; font-size: 24rpx; }
	.bottom-safe { height: calc(190rpx + env(safe-area-inset-bottom)); }
</style>
