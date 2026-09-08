<template>
	<view class="storage-page">
		<bobbo-nav-bar :title="pageTitle" title-align="left" />
		<view class="storage-content">
			<scroll-view v-if="devices.length > 1" class="device-tabs" scroll-x :show-scrollbar="false">
				<view class="device-tabs-inner">
					<view
						v-for="item in devices"
						:key="item.sn"
						class="device-tab"
						:class="{ active: item.sn === selectedSn }"
						@click="selectDevice(item.sn)"
					>
						<text>{{ item.nickname || '摄像头' }}</text>
					</view>
				</view>
			</scroll-view>

			<view v-if="currentDevice" class="device-heading">
				<view class="device-heading-copy">
					<text class="device-name">{{ currentDevice.nickname || '摄像头' }}</text>
					<text class="device-meta">SN · {{ currentDevice.sn }}</text>
				</view>
				<view class="state-pill" :class="{ online: status === 'online' }">
					<view class="state-dot"></view>
					<text>{{ statusLabel }}</text>
				</view>
			</view>

			<view v-if="loading && !summary" class="loading-card">
				<text>正在读取摄像头...</text>
			</view>

			<template v-else-if="summary">
				<view class="hero-card">
					<view class="hero-topline">
						<text class="eyebrow">本地存储</text>
						<text class="checked-at">{{ checkedAtLabel }}</text>
					</view>
					<text class="capacity-title">{{ storageTitle }}</text>
					<text class="capacity-note">{{ storageNote }}</text>
					<view class="capacity-track">
						<view class="capacity-used" :style="{ width: usedPercent + '%' }"></view>
					</view>
					<view class="capacity-row">
						<text>已用 {{ formatBytes(summary.storage.usedBytes) }}</text>
						<text>可用 {{ formatBytes(summary.storage.freeBytes) }}</text>
					</view>
				</view>

				<view class="section-card">
					<text class="section-title">录像</text>
					<view class="info-row">
						<text class="info-label">持续录像</text>
						<text class="info-value">{{ summary.recording.continuous ? '已开启' : '未开启' }}</text>
					</view>
					<view class="info-row">
						<text class="info-label">警报截图</text>
						<text class="info-value">{{ summary.recording.snapshotEnabled ? '已开启' : '未开启' }}</text>
					</view>
					<view class="info-row">
						<text class="info-label">录像分段</text>
						<text class="info-value">{{ packetLabel }}</text>
					</view>
					<text class="section-note">服务器会持续保持移动侦测、警报截图和进食分析所需的录像能力。</text>
				</view>

				<view class="section-card">
					<text class="section-title">画面</text>
					<view class="info-row">
						<text class="info-label">分辨率</text>
						<text class="info-value">{{ summary.picture.resolution || '设备自动' }}</text>
					</view>
					<view class="info-row">
						<text class="info-label">帧率</text>
						<text class="info-value">{{ summary.picture.fps ? summary.picture.fps + ' FPS' : '设备自动' }}</text>
					</view>
					<view class="info-row">
						<text class="info-label">编码</text>
						<text class="info-value">{{ summary.picture.codec || '设备自动' }}</text>
					</view>
				</view>
			</template>

			<view v-else class="empty-card">
				<text class="empty-title">暂时无法读取设备信息</text>
				<text class="empty-note">{{ errorText || '请确认摄像头在线后重试。' }}</text>
			</view>

			<button class="primary-button" :loading="loading" @click="refreshSummary">刷新设备信息</button>
			<button class="secondary-button" @click="syncDeviceTime">同步摄像头时间</button>
			<text v-if="currentDevice && currentDevice.role === 'member'" class="shared-note">这是家人共享的设备，你可以查看状态，设备配置由主人维护。</text>
		</view>
	</view>
</template>

<script>
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { readOwnedDevices, refreshOwnedDevices } = require('@/utils/ownedDeviceCache.js')

	const CACHE_PREFIX = 'bobbo_device_settings_summary_v1_'
	const CACHE_TTL_MS = 5 * 60 * 1000

	export default {
		data() {
			return {
				mode: 'storage',
				devices: [],
				selectedSn: '',
				summary: null,
				status: 'unknown',
				checkedAt: 0,
				loading: false,
				errorText: ''
			}
		},
		computed: {
			pageTitle() {
				if (this.mode === 'picture') return '画面设置'
				if (this.mode === 'recording') return '录像设置'
				return '存储管理'
			},
			currentDevice() {
				return this.devices.find((item) => item.sn === this.selectedSn) || this.devices[0] || null
			},
			statusLabel() {
				if (this.status === 'online') return '在线'
				if (this.status === 'offline') return '离线'
				return '状态未知'
			},
			usedPercent() {
				const storage = this.summary && this.summary.storage
				if (!storage || !storage.totalBytes) return 0
				return Math.max(0, Math.min(100, Math.round(storage.usedBytes / storage.totalBytes * 100)))
			},
			storageTitle() {
				const storage = this.summary && this.summary.storage
				if (!storage || !storage.available) return '未读取到容量'
				return `${storage.type || '本地存储'} · ${this.formatBytes(storage.totalBytes)}`
			},
			storageNote() {
				if (this.status !== 'online') return '摄像头离线，显示的是最近一次状态'
				return this.summary && this.summary.storage.available ? `已使用 ${this.usedPercent}%` : '设备在线，但没有返回容量信息'
			},
			packetLabel() {
				const value = Number(this.summary && this.summary.recording && this.summary.recording.packetMinutes)
				return value > 0 ? `${value} 分钟/段` : '设备自动'
			},
			checkedAtLabel() {
				if (!this.checkedAt) return '刚刚读取'
				const date = new Date(this.checkedAt)
				return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 更新`
			}
		},
		onLoad(options) {
			this.mode = ['storage', 'picture', 'recording'].includes(String(options && options.mode)) ? String(options.mode) : 'storage'
			this.selectedSn = String(options && options.sn || '')
		},
		onShow() {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.restoreDevices()
			this.loadDevices()
		},
		methods: {
			restoreDevices() {
				this.devices = readOwnedDevices(uni)
				if (!this.selectedSn && this.devices[0]) this.selectedSn = this.devices[0].sn
				this.restoreCachedSummary()
			},
			async loadDevices() {
				const result = await refreshOwnedDevices(() => callBackend('/api/devices'), uni)
				if (result && Array.isArray(result.devices)) this.devices = result.devices
				if (!this.selectedSn && this.devices[0]) this.selectedSn = this.devices[0].sn
				if (this.selectedSn) await this.refreshSummary({ silent: !!this.summary })
			},
			cacheKey() {
				return CACHE_PREFIX + this.selectedSn
			},
			restoreCachedSummary() {
				if (!this.selectedSn) return
				const cached = uni.getStorageSync(this.cacheKey())
				if (!cached || !cached.summary) return
				this.summary = cached.summary
				this.status = cached.status || 'unknown'
				this.checkedAt = Number(cached.checkedAt || 0)
				if (Date.now() - this.checkedAt > CACHE_TTL_MS) this.errorText = '正在更新设备状态'
			},
			selectDevice(sn) {
				if (!sn || sn === this.selectedSn) return
				this.selectedSn = sn
				this.summary = null
				this.status = 'unknown'
				this.errorText = ''
				this.restoreCachedSummary()
				this.refreshSummary({ silent: !!this.summary })
			},
			async refreshSummary(options = {}) {
				if (!this.selectedSn || this.loading) return
				this.loading = true
				this.errorText = ''
				try {
					const payload = await callBackend('/api/devices/' + encodeURIComponent(this.selectedSn) + '/settings-summary')
					this.summary = payload.summary || null
					this.status = payload.status || 'unknown'
					this.checkedAt = Number(payload.checkedAt || Date.now())
					uni.setStorageSync(this.cacheKey(), {
						summary: this.summary,
						status: this.status,
						checkedAt: this.checkedAt
					})
					if (!options.silent) uni.showToast({ title: '设备信息已更新', icon: 'success' })
				} catch (error) {
					this.errorText = getBackendErrorMessage(error, '读取失败，请稍后重试')
					if (!this.summary) uni.showToast({ title: this.errorText, icon: 'none' })
				} finally {
					this.loading = false
				}
			},
			async syncDeviceTime() {
				try {
					uni.showLoading({ title: '同步中...' })
					const payload = await callBackend('/api/app/foreground-sync', { method: 'POST' })
					const row = (payload.results || []).find((item) => item.sn === this.selectedSn)
					uni.hideLoading()
					if (row && row.synced) {
						uni.showToast({ title: '时间已同步', icon: 'success' })
						this.refreshSummary({ silent: true })
					} else {
						uni.showToast({ title: '设备离线，暂未同步', icon: 'none' })
					}
				} catch (error) {
					uni.hideLoading()
					uni.showToast({ title: '时间同步失败', icon: 'none' })
				}
			},
			formatBytes(value) {
				const bytes = Number(value || 0)
				if (!bytes) return '—'
				const gb = bytes / 1024 / 1024 / 1024
				return gb >= 10 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(1)} GB`
			}
		}
	}
</script>

<style>
	.storage-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.storage-content { padding: 24rpx 40rpx calc(52rpx + env(safe-area-inset-bottom)); }
	.device-tabs { width: 100%; margin-bottom: 28rpx; white-space: nowrap; }
	.device-tabs-inner { display: inline-flex; gap: 12rpx; padding-right: 24rpx; }
	.device-tab { min-width: 144rpx; height: 64rpx; box-sizing: border-box; padding: 0 26rpx; border: 2rpx solid #E8E8E5; border-radius: 32rpx; background: #FFFFFF; color: #5A5A56; font-size: 24rpx; line-height: 60rpx; text-align: center; }
	.device-tab.active { border-color: #141414; background: #141414; color: #FFFFFF; }
	.device-heading { display: flex; align-items: center; min-height: 98rpx; margin-bottom: 22rpx; }
	.device-heading-copy { min-width: 0; flex: 1; }
	.device-name { display: block; overflow: hidden; font-size: 36rpx; line-height: 48rpx; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
	.device-meta { display: block; margin-top: 2rpx; color: #989893; font-size: 22rpx; line-height: 32rpx; }
	.state-pill { height: 48rpx; padding: 0 18rpx; border-radius: 24rpx; background: #F1F1EF; color: #989893; display: flex; align-items: center; gap: 9rpx; font-size: 22rpx; }
	.state-pill.online { color: #2FA35C; }
	.state-dot { width: 10rpx; height: 10rpx; border-radius: 50%; background: #C4C4C0; }
	.state-pill.online .state-dot { background: #3DDC74; }
	.hero-card, .section-card, .loading-card, .empty-card { box-sizing: border-box; margin-bottom: 22rpx; border: 2rpx solid #E8E8E5; border-radius: 32rpx; background: #FFFFFF; }
	.hero-card { padding: 30rpx; }
	.hero-topline { display: flex; align-items: center; }
	.eyebrow { flex: 1; color: #C9A24B; font-size: 22rpx; line-height: 32rpx; font-weight: 650; letter-spacing: 2rpx; }
	.checked-at { color: #B4B4B0; font-size: 21rpx; }
	.capacity-title { display: block; margin-top: 16rpx; font-size: 34rpx; line-height: 46rpx; font-weight: 700; }
	.capacity-note { display: block; margin-top: 4rpx; color: #989893; font-size: 23rpx; line-height: 34rpx; }
	.capacity-track { height: 18rpx; margin-top: 28rpx; overflow: hidden; border-radius: 9rpx; background: #F1F1EF; }
	.capacity-used { height: 100%; min-width: 0; border-radius: 9rpx; background: #141414; }
	.capacity-row { display: flex; justify-content: space-between; margin-top: 14rpx; color: #989893; font-size: 21rpx; line-height: 30rpx; }
	.section-card { padding: 10rpx 30rpx 24rpx; }
	.section-title { display: block; padding: 22rpx 0 12rpx; font-size: 29rpx; line-height: 40rpx; font-weight: 700; }
	.info-row { display: flex; align-items: center; min-height: 80rpx; border-top: 2rpx solid #EFEFED; }
	.info-label { flex: 1; color: #5A5A56; font-size: 25rpx; }
	.info-value { color: #141414; font-size: 25rpx; font-weight: 550; }
	.section-note { display: block; padding-top: 18rpx; border-top: 2rpx solid #EFEFED; color: #989893; font-size: 21rpx; line-height: 34rpx; }
	.loading-card, .empty-card { padding: 62rpx 30rpx; color: #989893; font-size: 24rpx; text-align: center; }
	.empty-title { display: block; color: #141414; font-size: 28rpx; font-weight: 650; }
	.empty-note { display: block; margin-top: 12rpx; color: #989893; font-size: 22rpx; line-height: 34rpx; }
	.primary-button, .secondary-button { width: 100%; height: 92rpx; padding: 0; margin: 18rpx 0 0; border-radius: 46rpx; font-size: 26rpx; line-height: 92rpx; }
	.primary-button { border: 0; background: #141414; color: #FFFFFF; }
	.secondary-button { border: 2rpx solid #E8E8E5; background: #FFFFFF; color: #141414; }
	.primary-button::after, .secondary-button::after { border: 0; }
	.shared-note { display: block; margin-top: 20rpx; color: #989893; font-size: 21rpx; line-height: 34rpx; text-align: center; }
</style>
