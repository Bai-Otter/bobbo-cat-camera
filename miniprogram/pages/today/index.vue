<template>
	<view class="today-page" :style="{ paddingTop: statusBarHeight + 'px' }">
		<swiper
			v-if="catProfiles.length > 0"
			class="pet-switcher"
			circular
			:current="activeCatIndex"
			:duration="280"
			:style="{ paddingRight: headerRightInset + 'px' }"
			@change="onCatSwipe"
		>
			<swiper-item v-for="cat in catProfiles" :key="catKey(cat)">
				<view class="selected-pet-header" @click.stop="advanceCat">
					<view class="pet-avatar">
						<image class="pet-avatar-image" :src="cat.avatar" mode="aspectFill" />
					</view>
					<view class="pet-heading-main">
						<view class="pet-title-row">
							<text class="pet-name">{{cat.name}}</text>
							<view class="cat-dots" aria-hidden="true">
								<view
									v-for="(dotCat, index) in catProfiles"
									:key="dotCat.id"
									class="cat-dot"
									:class="{ active: index === activeCatIndex }"
								></view>
							</view>
						</view>
					</view>
				</view>
			</swiper-item>
		</swiper>
		<view class="page-header">
			<view class="page-title">
				<text class="page-title-line">今天吃得</text>
				<text class="page-title-line">怎么样</text>
			</view>
		</view>

		<view class="device-section" v-for="item in activeCatDashboard ? [activeCatDashboard] : []" :key="item.id">
			<view class="score-summary" @click="goTodayDetail(item)">
				<view class="score-main">
					<text class="score-kicker">{{item.activityReady ? '今日进食活性' : '进食活性'}}</text>
					<text class="score-value" :class="{ 'score-value-building': !item.activityReady }">{{item.activityScore}}</text>
				</view>
				<view class="score-context">
					<view class="score-status">
						<view class="status-dot" :class="{ muted: !item.activityReady }"></view>
						<text class="score-status-text">{{item.activityLabel}}</text>
					</view>
				</view>
			</view>

			<view class="section-separator"></view>
			<view class="metric-grid" @click="goTodayDetail(item)">
				<view class="metric-item">
					<text class="metric-label">频次</text>
					<view class="metric-value-row"><text class="metric-value">{{item.todayEatCount}}</text><text class="metric-unit">次</text></view>
				</view>
				<view class="metric-divider"></view>
				<view class="metric-item">
					<text class="metric-label">总时长</text>
					<view class="metric-value-row"><text class="metric-value">{{item.eatingDuration.value}}</text><text class="metric-unit">{{item.eatingDuration.unit}}</text></view>
				</view>
				<view class="metric-divider"></view>
				<view class="metric-item">
					<text class="metric-label">活性</text>
					<text class="metric-value metric-word">{{item.activityLabel}}</text>
				</view>
			</view>
			<view class="section-separator"></view>

			<view class="activity-chart">
				<view class="chart-header">
					<view>
						<text class="chart-title">进食活性</text>
					</view>
					<view class="chart-info">i</view>
				</view>
				<view class="chart-plot" v-if="item.activityReady">
					<view class="chart-grid-line line-bottom"></view>
					<image class="activity-curve" src="/static/images/feeding-activity-curve.svg" mode="scaleToFill" />
				</view>
				<view class="chart-axis" v-if="item.activityReady"><text>00:00</text><text>06:00</text><text>12:00</text><text>18:00</text><text>24:00</text></view>
				<view class="activity-building" v-else>
					<text class="activity-building-title">{{item.activityLabel}}</text>
				</view>
			</view>

			<view class="foodcast-entry" v-if="item.featuredClip">
				<view class="foodcast-cover" @click="playFeatured(item)">
					<image class="foodcast-image" :src="item.featuredClip.cover" mode="aspectFill" />
					<view class="foodcast-play"><cat-icon name="play" :size="32" color="#141414" /></view>
				</view>
				<view class="foodcast-copy">
					<text class="foodcast-title">今日吃播已更新</text>
					<text class="foodcast-subtitle">{{item.featuredClip.title || '记录今天的进食瞬间'}}</text>
				</view>
				<view class="foodcast-action" @click="switchToClips(item)"><text>去看看</text><text class="action-arrow">›</text></view>
			</view>
			<view class="foodcast-entry foodcast-empty" v-else>
				<view class="empty-foodcast-icon"><cat-icon name="foodcast" :size="38" color="#989893" /></view>
				<view class="foodcast-copy">
					<text class="foodcast-title">{{deviceEmptyTitle(item)}}</text>
					<text class="foodcast-subtitle">{{deviceEmptyDesc(item)}}</text>
				</view>
				<view class="foodcast-action" v-if="item.diaryError" @click="loadDiaryForDevice(item, false)"><text>重试</text></view>
				<view class="foodcast-action" v-else @click="switchToClips(item)"><text>{{item.clipCount}} 条</text><text class="action-arrow">›</text></view>
			</view>
		</view>

		<view class="bottom-safe"></view>
		<app-tab-bar current="today" />
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	import appTabBar from '@/components/app-tab-bar/app-tab-bar.vue'
	const { formatDateKey } = require('@/utils/demoDiary.js')
	const {
		callDemoData,
		getUnreadNotificationCount,
		markLocalNotificationsRead,
		readLocalNotifications,
		recordLocalNotifications
	} = require('@/utils/demoCloud.js')
	const { ensureAppSession, readAppAuthState } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { readCatProfiles, refreshCatProfiles, resolveActiveCat } = require('@/utils/catProfiles.js')
	const { buildOwnedDeviceCards, selectDirectLiveSdkDevices } = require('@/utils/deviceMediaState.js')
	const { refreshOwnedDevices, replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')
	const { fetchAccessibleDeviceStatuses, mergeAccessibleDeviceStatuses } = require('@/utils/accessibleDeviceStatus.js')
	const { readPageData, writePageData } = require('@/utils/pageDataCache.js')
	const {
		applyTodayDiary,
		reconcileTodayDeviceCards,
		updateTodayDeviceCard
	} = require('@/utils/todayDeviceState.js')

		export default {
		components: { catIcon, appTabBar },
		data() {
			return {
				hasUnread: false,
				dateKey: formatDateKey(),
				deviceCards: [],
				devicesLoading: false,
				devicesError: '',
				activeDeviceSn: '',
				notificationEntryDeviceSn: '',
				notificationEntryDate: '',
				notificationEntryEvent: '',
					activeCatId: '',
					activeCatRef: '',
				catProfiles: [],
				statusBarHeight: 24,
				headerRightInset: 16,
				demoHealth: null
			}
		},
		computed: {
			activeCat() {
				return this.catProfiles.find((cat) => (cat.catRef || cat.id) === this.activeCatRef)
					|| this.catProfiles.find((cat) => cat.id === this.activeCatId)
					|| this.catProfiles[0] || null
			},
			activeCatIndex() {
				if (!this.activeCat) return 0
				return Math.max(0, this.catProfiles.findIndex((cat) => cat.id === this.activeCat.id))
			},
			activeCatDashboard() {
				if (!this.activeCat) return null
				const sourceDevice = this.deviceCards.find((item) => (
					(item.primaryCatRef && item.primaryCatRef === this.activeCat.catRef)
					|| (!item.primaryCatRef && item.primaryCatId === this.activeCat.id)
				))
				const activity = sourceDevice && sourceDevice.feedingActivity ? sourceDevice.feedingActivity : {}
				const validDayCount = Number(activity.validDayCount) || 0
				const requiredValidDays = Number(activity.requiredValidDays) || 7
				const activityReady = activity.state && activity.state !== 'baseline_building' && Number.isFinite(Number(activity.score))
				const actualEatingSeconds = Number(sourceDevice && sourceDevice.actualEatingSeconds) || 0
				return {
					id: this.activeCat.id,
					name: this.activeCat.name,
					sn: sourceDevice ? sourceDevice.sn : '',
					token: sourceDevice ? sourceDevice.token : '',
					nickname: sourceDevice ? sourceDevice.nickname : '',
					todayEatCount: Number(sourceDevice && sourceDevice.todayEatCount) || 0,
					eatMinutes: Number(sourceDevice && sourceDevice.eatMinutes) || 0,
					actualEatingSeconds,
					eatingDuration: actualEatingSeconds >= 60
						? { value: (actualEatingSeconds / 60).toFixed(actualEatingSeconds % 60 === 0 ? 0 : 1), unit: '分钟' }
						: { value: Math.round(actualEatingSeconds), unit: '秒' },
					catIdentityPlaceholder: sourceDevice
						? (sourceDevice.feedingStatsVersion ? 'V3.2 摄像头统计' : '回放分析中')
						: '暂未关联摄像头',
					statsAttribution: sourceDevice
						? `${sourceDevice.nickname || '摄像头'} · 摄像头统计，暂未区分猫咪`
						: '该猫咪暂未关联摄像头，暂不显示其他设备的数据',
					featuredClip: sourceDevice ? sourceDevice.featuredClip : null,
					clipCount: Number(sourceDevice && sourceDevice.clipCount) || 0,
					activityReady,
					activityScore: activityReady ? Math.round(Number(activity.score)) : '—',
					activityLabel: activity.label || '基线建立中',
					activityComparison: activityReady ? '与近 14 个有效日个人基线比较' : '首日开始记录，满 7 个有效日后形成基线',
					activityProgress: `已记录 ${validDayCount}/${requiredValidDays} 个有效日`,
					activityVersion: activity.configVersion || 'ChewMeter 原型',
					diaryLoading: !!(sourceDevice && sourceDevice.diaryLoading),
					diaryError: sourceDevice ? sourceDevice.diaryError : '',
					sourceDevice
				}
			},
			activeDevice() {
				return this.deviceCards.find((item) => item.sn === this.activeDeviceSn) || this.deviceCards[0] || null
			}
		},
			onLoad(options = {}) {
				const deviceSn = options.deviceSn ? decodeURIComponent(options.deviceSn) : ''
				const date = /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || '')) ? String(options.date) : ''
				this.notificationEntryDeviceSn = deviceSn
				this.notificationEntryDate = date
				this.notificationEntryEvent = options.feedingEvent ? decodeURIComponent(options.feedingEvent) : ''
				if (deviceSn) uni.setStorageSync('lastViewedDeviceSn', deviceSn)
			},
			onShow() {
			const windowInfo = typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : { statusBarHeight: 24, windowWidth: 375 }
			const menuButton = typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function' ? wx.getMenuButtonBoundingClientRect() : null
			this.statusBarHeight = Number(windowInfo.statusBarHeight) || 24
			this.headerRightInset = menuButton && menuButton.left ? Math.max(16, Number(windowInfo.windowWidth) - Number(menuButton.left) + 8) : 16
			if (!ensureAppSession({ message: '请先登录' })) return
			this.dateKey = this.notificationEntryDate || formatDateKey()
			this.activeDeviceSn = this.notificationEntryDeviceSn || uni.getStorageSync('lastViewedDeviceSn') || this.activeDeviceSn
			this.loadCatProfiles()
			this.updateUnread()
			const cached = readPageData(`today:${this.dateKey}`, { uniApi: uni, tags: ['today', 'devices', 'cats'] })
			if (cached && Array.isArray(cached.deviceCards)) {
				this.deviceCards = cached.deviceCards
				this.activeDeviceSn = cached.activeDeviceSn || this.activeDeviceSn
			}
			this.loadAllDevices().then(() => this.refreshCatProfilesFromBackend()).catch(() => {})
		},
		methods: {
			saveTodaySnapshot() {
				writePageData(`today:${this.dateKey}`, {
					deviceCards: this.deviceCards,
					activeDeviceSn: this.activeDeviceSn
				}, { uniApi: uni, tags: ['today', 'devices', 'cats'] })
			},
			catKey(cat) { return (cat && (cat.catRef || cat.id)) || '' },
			loadCatProfiles() {
				this.catProfiles = readCatProfiles(uni)
				const storedCatRef = uni.getStorageSync('lastViewedCatRef') || ''
				const storedCatId = uni.getStorageSync('lastViewedCatId') || ''
				const activeCat = resolveActiveCat(this.catProfiles, storedCatRef || storedCatId)
				this.activeCatId = activeCat ? activeCat.id : ''
				this.activeCatRef = activeCat ? (activeCat.catRef || activeCat.id) : ''
				if (activeCat) {
					if (storedCatId !== activeCat.id) uni.setStorageSync('lastViewedCatId', activeCat.id)
					uni.setStorageSync('lastViewedCatRef', this.activeCatRef)
				} else if (typeof uni.removeStorageSync === 'function') {
					uni.removeStorageSync('lastViewedCatId')
					uni.removeStorageSync('lastViewedCatRef')
				}
			},
			async refreshCatProfilesFromBackend() {
				const result = await refreshCatProfiles({ storage: uni, callBackend, accountId: readAppAuthState(uni).openid, devices: this.deviceCards })
				if (!result.refreshed) return
				this.catProfiles = result.cats
				const activeCat = resolveActiveCat(this.catProfiles, this.activeCatRef || this.activeCatId)
				this.activeCatId = activeCat ? activeCat.id : ''
				this.activeCatRef = activeCat ? (activeCat.catRef || activeCat.id) : ''
				if (activeCat) {
					uni.setStorageSync('lastViewedCatId', activeCat.id)
					uni.setStorageSync('lastViewedCatRef', this.activeCatRef)
				}
				else if (typeof uni.removeStorageSync === 'function') uni.removeStorageSync('lastViewedCatId')
			},
			updateUnread() {
				this.hasUnread = getUnreadNotificationCount(uni) > 0
			},
			callSdk(method, payload, timeoutMs = 12000) {
				return new Promise((resolve, reject) => {
					let settled = false
					const timer = setTimeout(() => {
						if (settled) return
						settled = true
						reject(new Error(`${method} timeout after ${timeoutMs}ms`))
					}, timeoutMs)
					try {
						if (!this.JLWXSDK || typeof this.JLWXSDK[method] !== 'function') throw new Error(`JLWXSDK.${method} is unavailable`)
						this.JLWXSDK[method](payload, (result) => {
							if (settled) return
							settled = true
							clearTimeout(timer)
							resolve(result || {})
						})
					} catch (error) {
						if (!settled) {
							settled = true
							clearTimeout(timer)
							reject(error)
						}
					}
				})
			},
			extractRows(result, keys) {
				const data = result && result.data ? result.data : result
				if (Array.isArray(data)) return data
				for (const key of keys) {
					if (data && Array.isArray(data[key])) return data[key]
				}
				return []
			},
			async fetchDeviceTokenRows(devices) {
				const sns = devices.map((item) => item.sn).filter(Boolean)
				if (sns.length === 0) return []
				try {
					const result = await this.callSdk('getDeviceToken', { sns })
					return this.extractRows(result, ['tokens', 'deviceTokens'])
				} catch (error) {
					console.log('[today] getDeviceToken failed', error)
					return []
				}
			},
			async fetchDeviceStatusRows(devices) {
				const tokens = devices.map((item) => item.token).filter(Boolean)
				if (tokens.length === 0) return []
				try {
					const result = await this.callSdk('getNewDeviceStatus', { token: tokens })
					return this.extractRows(result, ['statusList', 'devices'])
				} catch (error) {
					console.log('[today] getNewDeviceStatus failed', error)
					return []
				}
			},
			async loadAllDevices() {
				if (this.devicesLoading) return
				this.devicesLoading = true
				this.devicesError = ''
				try {
					const refreshed = await refreshOwnedDevices(async () => {
						const result = await callBackend('/api/devices')
						return Array.isArray(result.devices) ? result.devices : []
					}, uni)
					const ownedDevices = refreshed.devices
					if (!refreshed.refreshed) {
						console.warn('[today] backend device refresh failed, using cache', refreshed.error)
					}
					console.log('[today] owned devices resolved', {
						source: refreshed.refreshed ? 'backend' : 'cache',
						devices: ownedDevices.map((item) => ({ sn: item.sn, active: item.active })),
						lastViewedSn: uni.getStorageSync('lastViewedDeviceSn') || ''
					})
					const sdkDevices = selectDirectLiveSdkDevices(ownedDevices, { sharedAccessFresh: refreshed.refreshed })
					const tokenRows = await this.fetchDeviceTokenRows(sdkDevices)
					const cards = buildOwnedDeviceCards({ devices: ownedDevices, tokenRows, now: Date.now() })
					const statuses = await fetchAccessibleDeviceStatuses(cards, callBackend)
					const devices = mergeAccessibleDeviceStatuses(cards, statuses)
					this.deviceCards = reconcileTodayDeviceCards(this.deviceCards, devices)
					replaceOwnedDevices(this.deviceCards, uni)
					if (!this.deviceCards.some((item) => item.sn === this.activeDeviceSn)) {
						this.activeDeviceSn = this.deviceCards[0] ? this.deviceCards[0].sn : ''
					}
					await Promise.allSettled(this.deviceCards.map((item) => this.loadDiaryForDevice(item, false)))
					this.saveTodaySnapshot()
				} catch (error) {
					console.log('[today] load devices failed', error)
					this.devicesError = getBackendErrorMessage(error, '暂时无法加载设备，请稍后重试')
				} finally {
					this.devicesLoading = false
				}
			},
			async syncDiary(item, force) {
				if (!item || !item.sn) return { ok: false, error: 'NO_DEVICE' }
				if (!force) {
					return callDemoData('getDiary', { deviceSn: item.sn, date: this.dateKey, sync: false })
				}
				const syncRes = await callDemoData('syncFeedAnalysis', { deviceSn: item.sn, date: this.dateKey, force })
				if (syncRes && syncRes.ok && syncRes.diary) return syncRes
				return callDemoData('getDiary', { deviceSn: item.sn, date: this.dateKey, sync: false })
			},
			async loadDiaryForDevice(item, force) {
				if (!item || !item.sn) return
				this.deviceCards = updateTodayDeviceCard(this.deviceCards, item.sn, {
					diaryLoading: !force && !item.diary,
					diaryRefreshing: !!force,
					diaryError: ''
				})
				try {
					const res = await this.syncDiary(item, force)
					if (!res || !res.ok) throw new Error((res && res.error) || 'DIARY_LOAD_FAILED')
					this.deviceCards = updateTodayDeviceCard(this.deviceCards, item.sn, (card) => applyTodayDiary(card, res.diary))
					return res.diary || null
				} catch (error) {
					console.log('[today] diary failed', item.sn, error)
					this.deviceCards = updateTodayDeviceCard(this.deviceCards, item.sn, {
						diaryLoading: false,
						diaryRefreshing: false,
						diaryError: '今日记录加载失败'
					})
					return null
				}
			},
			async refreshTodayDiary(item) {
				if (!item || item.diaryRefreshing || item.diaryLoading) return
				const previousDiary = item.diary
				const diary = await this.loadDiaryForDevice(item, true)
				if (!diary) return
					recordLocalNotifications(uni, previousDiary, diary, { deviceSn: item.sn, date: this.dateKey })
				this.saveTodaySnapshot()
				this.updateUnread()
				uni.showToast({ title: diary.clipCount > 0 ? '今日记录已刷新' : '今天暂无有效片段', icon: 'none' })
			},
			devicePayload(item) {
				return {
					online: !!item._online,
					battery: item.battery || 0,
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
			onCatSwipe(event) {
				const index = Number(event && event.detail && event.detail.current)
				if (!Number.isInteger(index) || index < 0 || index >= this.catProfiles.length) return
				const next = this.catProfiles[index]
				this.activeCatId = next.id
				this.activeCatRef = next.catRef || next.id
				uni.setStorageSync('lastViewedCatId', next.id)
				uni.setStorageSync('lastViewedCatRef', this.activeCatRef)
			},
			advanceCat() {
				if (this.catProfiles.length < 2) return
				const next = this.catProfiles[(this.activeCatIndex + 1) % this.catProfiles.length]
				this.activeCatId = next.id
				this.activeCatRef = next.catRef || next.id
				uni.setStorageSync('lastViewedCatId', next.id)
				uni.setStorageSync('lastViewedCatRef', this.activeCatRef)
			},
			goTodayDetail(item) {
				const cat = this.activeCat || {}
				const dashboard = item || this.activeCatDashboard || {}
				uni.setStorageSync('bobboTodayDetail', {
					cat: { id: cat.id || '', name: cat.name || '猫咪', avatar: cat.avatar || '' },
					dashboard: {
						todayEatCount: Number(dashboard.todayEatCount) || 0,
						eatMinutes: Number(dashboard.eatMinutes) || 0,
						actualEatingSeconds: Number(dashboard.actualEatingSeconds) || 0,
						catIdentityPlaceholder: dashboard.catIdentityPlaceholder || '待设置主猫'
					},
					health: dashboard.sourceDevice && dashboard.sourceDevice.feedingActivity
						? { ...dashboard.sourceDevice.feedingActivity }
						: { state: 'baseline_building', label: '基线建立中', score: null },
					dateKey: this.dateKey,
					recordedAt: Date.now()
				})
				uni.navigateTo({
					url: '/pages/today/detail?catName=' + encodeURIComponent(cat.name || '猫咪')
				})
			},
			switchToClips(item) {
				if (!item || !item.sn) return
				uni.setStorageSync('lastViewedDeviceSn', item.sn)
				uni.reLaunch({ url: '/pages/clips/index' })
			},
			playFeatured(item) {
				if (!item || !item.featuredClip) return
				uni.setStorageSync('lastViewedDeviceSn', item.sn)
				uni.navigateTo({
					url: '/pages/live/replay?device=' + encodeURIComponent(JSON.stringify(this.devicePayload(item))) +
						'&clip=' + encodeURIComponent(JSON.stringify(item.featuredClip))
				})
			},
			deviceInitial(item) {
				return String((item && item.nickname) || '摄').trim().slice(0, 1)
			},
			deviceEmptyTitle(item) {
				if (item.diaryLoading) return '正在同步今日记录'
				if (item.diaryError) return item.diaryError
				if (item.feedingAnalysisState === 'pending') return '正在分析今日回放'
				if (item.feedingAnalysisState === 'partial') return '今日统计仍在补全'
				return '今天还没有小片段'
			},
			deviceEmptyDesc(item) {
				if (item.diaryLoading) return '正在读取这台设备的进食动态。'
				if (item.diaryError) return '其他设备不受影响，可以单独重试。'
				if (item.feedingAnalysisState === 'pending' || item.feedingAnalysisState === 'partial') return '服务器会在后台持续处理，无需停留在当前页面。'
				return '今天暂未识别到明确的进食片段。'
			},
			goNotifications() {
				const list = readLocalNotifications(uni)
				if (list.length === 0) {
					uni.showToast({ title: '暂无提醒', icon: 'none' })
					return
				}
				const latest = list[0]
				markLocalNotificationsRead(uni)
				this.updateUnread()
				uni.showModal({ title: '猫来吃饭提醒', content: (latest.message || '发现新的小猫动态') + '\n' + (latest.title || ''), showCancel: false })
			}
		}
	}
</script>

<style>
	.today-page { position: relative; min-height: 100vh; box-sizing: border-box; padding: 0 32rpx; background: #FBFBFA; color: #141414; }
	.pet-switcher { width: 100%; height: 104rpx; margin-top: 20rpx; box-sizing: border-box; }
	.selected-pet-header { height: 104rpx; padding-left: 4rpx; box-sizing: border-box; display: flex; align-items: center; }
	.pet-avatar { flex-shrink: 0; width: 80rpx; height: 80rpx; border-radius: 50%; overflow: hidden; background: #F1F1EF; }
	.pet-avatar-image { width: 100%; height: 100%; display: block; }
	.pet-heading-main { min-width: 0; flex: 1; margin-left: 22rpx; }
	.pet-title-row { min-width: 0; display: flex; align-items: center; gap: 14rpx; }
	.pet-name { display: block; min-width: 0; max-width: 220rpx; color: #141414; font-size: 32rpx; line-height: 42rpx; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.cat-dots { flex: none; height: 24rpx; display: flex; align-items: center; gap: 10rpx; }
	.cat-dot { width: 9rpx; height: 9rpx; border-radius: 50%; background: #DBDBD8; }
	.cat-dot.active { width: 22rpx; border-radius: 8rpx; background: #141414; }
	.page-header { padding: 40rpx 4rpx 44rpx; }
	.page-title { color: #141414; font-size: 64rpx; line-height: 1.12; font-weight: 700; letter-spacing: 0; }
	.page-title-line { display: block; color: inherit; font-size: inherit; line-height: inherit; font-weight: inherit; }
	.device-section { width: 100%; }
	.score-summary { min-height: 204rpx; padding: 18rpx 10rpx 32rpx; box-sizing: border-box; display: flex; align-items: center; }
	.score-main { flex: 0 0 50%; min-width: 0; }
	.score-kicker { display: block; color: #989893; font-size: 23rpx; line-height: 32rpx; }
	.score-value { display: block; margin-top: -6rpx; color: #141414; font-size: 196rpx; line-height: .9; font-weight: 400; }
	.score-value-building { margin-top: 18rpx; font-size: 100rpx; line-height: 1; }
	.score-context { flex: 1; min-width: 0; padding-left: 20rpx; }
	.score-status { display: flex; align-items: center; gap: 12rpx; }
	.status-dot { flex-shrink: 0; width: 15rpx; height: 15rpx; border-radius: 50%; background: #2FA35C; }
	.status-dot.muted { background: #989893; }
	.score-status-text { color: #141414; font-size: 30rpx; line-height: 40rpx; font-weight: 650; }
	.section-separator { height: 2rpx; background: #E8E8E5; }
	.metric-grid { min-height: 160rpx; padding: 24rpx 0; box-sizing: border-box; display: flex; align-items: stretch; }
	.metric-item { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.metric-divider { width: 2rpx; margin: 18rpx 0; background: #E8E8E5; }
	.metric-label { color: #989893; font-size: 22rpx; line-height: 30rpx; }
	.metric-value-row { margin-top: 6rpx; display: flex; align-items: baseline; justify-content: center; }
	.metric-value { color: #141414; font-size: 42rpx; line-height: 52rpx; font-weight: 650; }
	.metric-value.metric-word { margin-top: 6rpx; font-size: 36rpx; line-height: 52rpx; }
	.metric-unit { margin-left: 5rpx; color: #989893; font-size: 20rpx; }
	.activity-chart { padding: 40rpx 8rpx 30rpx; }
	.chart-header { display: flex; align-items: flex-start; justify-content: space-between; }
	.chart-title { display: block; color: #141414; font-size: 30rpx; line-height: 40rpx; font-weight: 650; }
	.chart-info { width: 38rpx; height: 38rpx; border: 2rpx solid #C4C4C0; border-radius: 50%; color: #989893; font-size: 21rpx; line-height: 36rpx; text-align: center; }
	.chart-plot { position: relative; height: 196rpx; margin-top: 22rpx; overflow: hidden; }
	.chart-grid-line { position: absolute; left: 0; right: 0; height: 2rpx; background: #EFEFED; }
	.line-bottom { bottom: 0; }
	.activity-curve { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.chart-axis { margin-top: 10rpx; display: flex; justify-content: space-between; color: #C4C4C0; font-size: 18rpx; }
	.activity-building { height: 176rpx; margin-top: 22rpx; border-top: 2rpx solid #EFEFED; border-bottom: 2rpx solid #EFEFED; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.activity-building-title { color: #141414; font-size: 28rpx; line-height: 38rpx; font-weight: 650; }
	.foodcast-entry { min-height: 152rpx; margin-top: 28rpx; padding: 14rpx; box-sizing: border-box; border-radius: 20rpx; background: #F1F1EF; display: flex; align-items: center; }
	.foodcast-cover { position: relative; flex-shrink: 0; width: 180rpx; height: 120rpx; border-radius: 12rpx; overflow: hidden; background: #E8E8E5; }
	.foodcast-image { width: 100%; height: 100%; display: block; }
	.foodcast-play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 54rpx; height: 54rpx; border-radius: 50%; background: #FFFFFF; display: flex; align-items: center; justify-content: center; }
	.foodcast-copy { min-width: 0; flex: 1; margin-left: 20rpx; }
	.foodcast-title { display: block; color: #141414; font-size: 26rpx; line-height: 36rpx; font-weight: 650; }
	.foodcast-subtitle { display: block; max-width: 290rpx; margin-top: 6rpx; color: #989893; font-size: 20rpx; line-height: 30rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.foodcast-action { flex-shrink: 0; min-height: 58rpx; padding: 0 14rpx; color: #141414; font-size: 21rpx; display: flex; align-items: center; justify-content: center; gap: 4rpx; }
	.action-arrow { color: #989893; font-size: 30rpx; line-height: 1; }
	.foodcast-empty { min-height: 142rpx; }
	.empty-foodcast-icon { flex-shrink: 0; width: 84rpx; height: 84rpx; border-radius: 18rpx; background: #E8E8E5; display: flex; align-items: center; justify-content: center; }
	.bottom-safe { height: 176rpx; }
</style>
