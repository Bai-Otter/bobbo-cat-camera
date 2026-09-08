<template>
	<view class="page" :style="{ paddingTop: statusBarHeight + 'px' }">
		<view class="header" :style="{ paddingRight: headerRightInset + 'px' }">
			<text class="title">吃播</text>
			<text v-if="device && device.role !== 'member'" class="custom" @click="goCustomize">自定义 +</text>
		</view>

		<view class="date-row">
			<picker mode="date" :value="selectedDate" :end="todayKey" @change="changeDate">
				<view class="date-picker">
					<text class="date">{{ dateLabel }}</text><text class="today">{{ selectedDate === todayKey ? '今天' : '选择日期' }}</text><text class="date-arrow">⌄</text>
				</view>
			</picker>
			<text class="status">{{ updateStatus }}</text>
		</view>

		<view v-if="heroMaterial" class="featured" @click="play(heroMaterial)">
			<image v-if="heroMaterial.coverUrl" class="featured-image" :src="heroMaterial.coverUrl" mode="aspectFill" />
			<view v-else class="cover-fallback"><cat-icon name="foodcast" :size="66" color="#A5A5A0" /></view>
			<view class="featured-shade"></view>
			<view class="play-large"><cat-icon name="play" :size="42" color="#FFFFFF" /></view>
			<view class="featured-meta">
				<text class="glass-label">{{ selectedDate === todayKey ? '今日一键吃播' : '当日一键吃播' }}</text>
				<text class="glass-duration">{{ formatDuration(heroMaterial.durationSec) }}</text>
			</view>
			<view class="featured-save" @click.stop="saveVideo(heroMaterial)">
				<text>{{ savingId === heroMaterial.id ? '保存中…' : '保存到相册' }}</text>
			</view>
		</view>
		<view v-else class="featured featured-empty">
			<text class="empty-title">{{ selectedDate === todayKey ? '今日精选正在准备' : '这一天还没有素材' }}</text>
		</view>

		<view class="section-heading">
			<text class="section-title">进食原始片段</text>
			<text class="section-count">{{ mealMaterials.length }} 顿</text>
		</view>

		<view class="meal-list">
			<view v-for="(item, index) in mealMaterials" :key="item.id" class="meal-row" @click="play(item)">
				<text class="number">{{ String(index + 1).padStart(2, '0') }}</text>
				<view class="meal-cover-wrap">
					<image v-if="item.coverUrl" class="meal-cover" :src="item.coverUrl" mode="aspectFill" />
					<view v-else class="meal-cover cover-fallback"><cat-icon name="foodcast" :size="34" color="#A5A5A0" /></view>
				</view>
				<view class="meal-copy">
					<text class="meal-title">{{ materialTitle(item, index) }}</text>
					<text class="meal-meta">{{ materialTime(item) }} · {{ formatDuration(item.durationSec) }}</text>
				</view>
				<view class="play-small"><cat-icon name="play" :size="25" color="#141414" /></view>
			</view>
			<view v-if="loading && !mealMaterials.length" class="loading-row"><text>正在同步 {{ selectedDate === todayKey ? '今日' : '当日' }}素材…</text></view>
		</view>

		<view v-if="!loading && mealMaterials.length === 0" class="empty-block">
			<text class="empty-title">这一天还没有进食片段</text>
		</view>

		<view v-if="playingUrl" class="player-mask" @click="closePlayer">
			<view class="player-shell" @click.stop>
				<video :key="playingId" class="player" :src="playingUrl" autoplay controls show-center-play-btn object-fit="contain" />
				<view class="player-actions">
					<text class="player-save" @click="saveVideo(playingItem)">{{ savingId === (playingItem && playingItem.id) ? '正在保存…' : '保存到相册' }}</text>
					<text class="player-close" @click="closePlayer">完成</text>
				</view>
			</view>
		</view>
		<view class="safe"></view>
		<app-tab-bar current="foodcast" />
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	import appTabBar from '@/components/app-tab-bar/app-tab-bar.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { selectDeviceBySn } = require('@/utils/todayDeviceState.js')
	const { readPageData, writePageData } = require('@/utils/pageDataCache.js')
	const { loadFoodcastCatalogForDevices } = require('@/utils/foodcastCatalog.js')
	const { saveFoodcastVideo } = require('@/utils/foodcast.js')

	function localDateKey(value) {
		const date = value instanceof Date ? value : new Date(value)
		return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
	}

	export default {
		components: { catIcon, appTabBar },
		data() {
			const todayKey = localDateKey(new Date())
			return { statusBarHeight: 24, headerRightInset: 16, loading: false, device: null, devices: [], daily: null, materials: [], selectedDate: todayKey, todayKey, playingUrl: '', playingId: '', playingItem: null, savingId: '', refreshTimer: null }
		},
		computed: {
			mealMaterials() { return this.materials.filter((item) => item.kind === 'meal') },
			heroMaterial() { return this.daily || null },
			dateLabel() { const parts = this.selectedDate.split('-'); return `${Number(parts[1])} 月 ${Number(parts[2])} 日` },
			updateStatus() {
				if (this.loading) return '素材整理中'
				if (this.daily) return '精选已生成'
				return this.mealMaterials.length ? `${this.mealMaterials.length} 顿已保存` : '等待素材'
			}
		},
		onLoad(options = {}) {
			if (options.date && /^\d{4}-\d{2}-\d{2}$/.test(options.date)) this.selectedDate = options.date
		},
		onShow() {
			const info = typeof wx !== 'undefined' && wx.getWindowInfo ? wx.getWindowInfo() : { statusBarHeight: 24, windowWidth: 375 }
			const menu = typeof wx !== 'undefined' && wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null
			this.statusBarHeight = Number(info.statusBarHeight) || 24
			this.headerRightInset = menu && menu.left ? Math.max(16, Number(info.windowWidth) - Number(menu.left) + 8) : 16
			if (!ensureAppSession({ message: '请先登录' })) return
			const cached = readPageData(this.clipsCacheKey(), { uniApi: uni, tags: ['clips', 'foodcasts', 'devices'] })
			if (cached) { this.device = cached.device || null; this.devices = Array.isArray(cached.devices) ? cached.devices : []; this.daily = cached.daily || null; this.materials = Array.isArray(cached.materials) ? cached.materials : [] }
			this.loadPage({ silent: !!cached })
			this.scheduleRefresh()
		},
		onHide() { this.clearRefresh(); this.closePlayer() },
		onUnload() { this.clearRefresh() },
		methods: {
			clearRefresh() { if (this.refreshTimer) clearTimeout(this.refreshTimer); this.refreshTimer = null },
			scheduleRefresh() {
				this.clearRefresh()
				if (this.selectedDate !== this.todayKey) return
				this.refreshTimer = setTimeout(async () => { this.refreshTimer = null; await this.loadPage({ silent: true }); this.scheduleRefresh() }, 30000)
			},
			clipsCacheKey() { return `clips:all-devices:${this.selectedDate}` },
			async changeDate(event) {
				const next = String(event && event.detail && event.detail.value || '')
				if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || next === this.selectedDate) return
				this.selectedDate = next; this.daily = null; this.materials = []; this.closePlayer()
				await this.loadPage(); this.scheduleRefresh()
			},
			async loadPage({ silent = false } = {}) {
				if (!silent) this.loading = true
				try {
					const devicesResult = await callBackend('/api/devices')
					const devices = Array.isArray(devicesResult.devices) ? devicesResult.devices : []
					this.devices = devices
					this.device = selectDeviceBySn(devices, uni.getStorageSync('lastViewedDeviceSn') || '')
					if (!this.device) return
					const catalog = await loadFoodcastCatalogForDevices({
						devices,
						date: this.selectedDate,
						fetchDaily: (query) => callBackend('/api/foodcasts/daily', { query }),
						fetchMaterials: (query) => callBackend('/api/foodcasts/materials', { query })
					})
					this.daily = catalog.daily
					this.materials = catalog.materials
					if (catalog.failedDeviceSns.length) console.log('[clips] partial device catalog failure', catalog.failedDeviceSns)
					writePageData(this.clipsCacheKey(), { device: this.device, devices: this.devices, daily: this.daily, materials: this.materials }, { uniApi: uni, tags: ['clips', 'foodcasts', 'devices'] })
				} catch (error) { console.log('[clips] catalog failed', error); if (!silent) uni.showToast({ title: '素材同步失败', icon: 'none' }) } finally { if (!silent) this.loading = false }
			},
			goCustomize() { if (this.device && this.device.role === 'member') return uni.showToast({ title: '共享成员只能查看吃播', icon: 'none' }); uni.navigateTo({ url: '/pages/clips/customize' }) },
			play(item) {
				if (!item || !item.previewUrl) return uni.showToast({ title: '视频正在准备', icon: 'none' })
				this.playingUrl = ''; this.playingId = String(item.id || Date.now()); this.playingItem = item
				this.$nextTick(() => { this.playingUrl = item.previewUrl })
			},
			closePlayer() { this.playingUrl = ''; this.playingId = ''; this.playingItem = null },
			async saveVideo(item) {
				if (this.savingId) return
				if (!item || !item.previewUrl) return uni.showToast({ title: '视频正在准备', icon: 'none' })
				this.savingId = String(item.id || 'foodcast')
				uni.showLoading({ title: '正在保存', mask: true })
				try {
					await saveFoodcastVideo(uni, item.previewUrl)
					uni.hideLoading()
					uni.showToast({ title: '已保存到相册', icon: 'success' })
				} catch (error) {
					uni.hideLoading()
					const code = String(error && error.message || '')
					const title = code === 'ALBUM_PERMISSION_DENIED' ? '开启权限后请再保存' : '保存失败，请重试'
					uni.showToast({ title, icon: 'none' })
				} finally {
					this.savingId = ''
				}
			},
			formatDuration(value) { const sec = Math.max(0, Math.round(Number(value) || 0)); return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}` },
			materialTime(item) { const time = Number(item.mealStartMs) || Number(item.createdAt) || Date.now(); const date = new Date(time); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` },
			materialTitle(item, index) { return `第 ${index + 1} 顿` }
		}
	}
</script>

<style>
	.page{min-height:100vh;background:#FBFBFA;color:#141414}.header{display:flex;align-items:flex-end;justify-content:space-between;padding:12rpx 48rpx 0}.title{font-size:58rpx;line-height:76rpx;font-weight:700}.custom{height:76rpx;display:flex;align-items:center;font-size:26rpx;font-weight:600}.date-row{padding:34rpx 48rpx 0;display:flex;align-items:center;justify-content:space-between}.date-picker{display:flex;align-items:center}.date{font-size:34rpx;font-weight:650}.today{margin-left:16rpx;font-size:24rpx;color:#989893}.date-arrow{margin-left:10rpx;font-size:24rpx;color:#989893}.status{font-size:23rpx;color:#2FA35C}.featured{position:relative;height:412rpx;margin-top:24rpx;overflow:hidden;background:#EFEEEC}.featured-image{width:100%;height:100%}.featured-shade{position:absolute;inset:0;background:rgba(20,20,20,.16)}.cover-fallback{display:flex;align-items:center;justify-content:center;background:#EFEEEC}.featured>.cover-fallback{width:100%;height:100%}.play-large{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:108rpx;height:108rpx;border-radius:50%;background:rgba(20,20,20,.38);display:flex;align-items:center;justify-content:center}.featured-meta{position:absolute;left:48rpx;bottom:24rpx;display:flex;align-items:center;gap:10rpx}.glass-label,.glass-duration,.featured-save{padding:10rpx 16rpx;border-radius:24rpx;background:rgba(20,20,20,.48);font-size:20rpx;font-weight:600;color:#FFFFFF}.featured-save{position:absolute;right:48rpx;bottom:24rpx;min-width:118rpx;text-align:center}.featured-empty{display:flex;align-items:center;justify-content:center}.section-heading{display:flex;align-items:center;justify-content:space-between;margin:34rpx 48rpx 8rpx;padding-bottom:20rpx;border-bottom:2rpx solid #E8E8E5}.section-title{font-size:28rpx;font-weight:650}.section-count{font-size:22rpx;color:#989893}.meal-list{padding:0 48rpx}.meal-row{height:124rpx;display:flex;align-items:center;gap:24rpx;border-bottom:2rpx solid #EFEFED}.number{width:32rpx;font-size:23rpx;font-weight:700;color:#B4B4B0}.meal-cover-wrap,.meal-cover{width:152rpx;height:92rpx;border-radius:18rpx;overflow:hidden}.meal-cover{display:flex}.meal-copy{flex:1;min-width:0}.meal-title{display:block;font-size:29rpx;font-weight:650}.meal-meta{display:block;margin-top:5rpx;font-size:22rpx;color:#989893}.play-small{width:42rpx;height:42rpx;border:2rpx solid #141414;border-radius:50%;display:flex;align-items:center;justify-content:center}.loading-row{padding:48rpx;text-align:center;font-size:23rpx;color:#989893}.empty-title{font-size:32rpx;line-height:44rpx;font-weight:650}.empty-block{padding:102rpx 48rpx 116rpx;display:flex;align-items:center;justify-content:center}.player-mask{position:fixed;inset:0;z-index:30;background:rgba(20,20,20,.76);display:flex;align-items:center;justify-content:center}.player-shell{width:100%;padding:24rpx 0;background:#141414}.player{width:100%;height:500rpx}.player-actions{padding:24rpx 48rpx 8rpx;display:flex;align-items:center;justify-content:space-between}.player-save,.player-close{font-size:26rpx;color:#FFFFFF}.player-save{font-weight:600}.safe{height:calc(190rpx + env(safe-area-inset-bottom))}
</style>
