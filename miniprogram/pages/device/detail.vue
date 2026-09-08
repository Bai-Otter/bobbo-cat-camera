<template>
	<view class="device-detail-page">
		<bobbo-nav-bar :title="deviceTitle" title-align="left">
			<view slot="right" class="detail-more-button" role="button" aria-label="更多设置，暂未接入" @click="showUnavailable">
				<text>···</text>
			</view>
		</bobbo-nav-bar>

		<view class="detail-preview">
			<image v-if="device.coverUrl" class="preview-image" :src="device.coverUrl" mode="aspectFill" />
			<view v-else class="preview-placeholder"><cat-icon name="camera" :size="88" color="#989893" /></view>
			<view class="status-badge">
				<view class="status-dot" :class="{ online: isOnline }"></view>
				<text>{{ statusLabel }}</text>
			</view>
		</view>

		<view class="detail-intro">
			<view class="intro-copy">
				<text class="intro-name">{{ deviceTitle }}</text>
				<text class="intro-meta">{{ device.sn ? 'SN · ' + device.sn : '设备编号暂未接入' }}</text>
			</view>
			<view class="live-action" :class="{ disabled: !device.sn }" @click="goLive"><text>查看实时</text></view>
		</view>

		<view class="settings-section">
			<text class="section-title">设备信息</text>
			<view class="setting-list">
				<view class="setting-row">
					<text class="setting-label">名称</text>
					<text class="setting-value">{{ deviceTitle }}</text>
				</view>
				<view class="setting-row">
					<text class="setting-label">位置</text>
					<text class="setting-value unavailable">{{ device.location || '暂未接入' }}</text>
				</view>
			</view>
		</view>

		<view class="settings-section">
			<text class="section-title">使用设置</text>
			<view class="setting-list">
				<view class="setting-row">
					<text class="setting-label">画质</text>
					<text class="setting-value unavailable">高清 · 演示数据</text>
				</view>
				<view class="setting-row">
					<text class="setting-label">存储</text>
					<text class="setting-value unavailable">暂未接入</text>
				</view>
				<view class="setting-row">
					<text class="setting-label">固件</text>
					<text class="setting-value unavailable">{{ device.firmware || '暂未接入' }}</text>
				</view>
				<view class="setting-row">
					<text class="setting-label">通知</text>
					<text class="setting-value unavailable">暂未接入</text>
				</view>
				<view class="setting-row actionable" @click="goShare">
					<text class="setting-label">共享</text>
					<view class="setting-trailing"><text class="setting-value">前往共享页</text><text class="row-arrow">›</text></view>
				</view>
			</view>
		</view>

		<view class="remove-action disabled" aria-disabled="true">
			<text class="remove-title">移除设备</text>
			<text class="remove-note">暂未接入</text>
		</view>
		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	import bobboNavBar from '@/components/bobbo-nav-bar/bobbo-nav-bar.vue'
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { readOwnedDevices, replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')
	const { invalidatePageDataTags } = require('@/utils/pageDataCache.js')
	const DEVICE_DETAIL_PREVIEW_KEY = 'bobbo_device_detail_preview'

	export default {
		name: 'device-detail',
		components: { bobboNavBar, catIcon },
		data() {
			return {
				device: {}
			}
		},
		computed: {
			deviceTitle() {
				return this.device.nickname || '设备详情'
			},
			isOnline() {
				return this.device.online === true || this.device.status === 'online'
			},
			statusLabel() {
				if (this.device.status !== 'online' && this.device.status !== 'offline') return '设备状态暂未载入'
				return this.isOnline ? '设备在线' : '设备离线'
			}
		},
		onLoad(options) {
			const sn = options && options.sn ? decodeURIComponent(options.sn) : ''
			let preview = uni.getStorageSync(DEVICE_DETAIL_PREVIEW_KEY) || {}
			if (typeof preview === 'string') {
				try {
					preview = JSON.parse(preview) || {}
				} catch (error) {
					preview = {}
				}
			}
			if (preview.sn !== sn) {
				this.device = { sn }
				return
			}
			this.device = {
				sn,
				nickname: typeof preview.nickname === 'string' ? preview.nickname : '',
				online: preview.online === true,
				status: preview.status === 'online' ? 'online' : 'offline',
				coverUrl: typeof preview.coverUrl === 'string' ? preview.coverUrl : '',
				role: preview.role === 'member' ? 'member' : 'owner',
				primaryCatId: typeof preview.primaryCatId === 'string' ? preview.primaryCatId : '',
				primaryCatRef: typeof preview.primaryCatRef === 'string' ? preview.primaryCatRef : '',
				permissions: Array.isArray(preview.permissions) ? preview.permissions : [],
				location: typeof preview.location === 'string' ? preview.location : ''
			}
		},
		onShow() {
			this.refreshDeviceMetadata()
		},
		methods: {
			pruneStaleDevice(sn) {
				const remaining = readOwnedDevices(uni).filter((item) => item.sn !== sn)
				replaceOwnedDevices(remaining, uni)
				if (uni.getStorageSync('lastViewedDeviceSn') === sn) uni.removeStorageSync('lastViewedDeviceSn')
				const preview = uni.getStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
				if (preview && preview.sn === sn) uni.removeStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
				invalidatePageDataTags(['devices', 'profile', 'today', 'live', 'clips'], uni)
				uni.showToast({ title: '这台设备已不在你的家庭中', icon: 'none', duration: 1800 })
				setTimeout(() => uni.navigateBack(), 300)
			},
			async refreshDeviceMetadata() {
				if (!this.device.sn) return
				try {
					const payload = await callBackend('/api/devices')
					const latest = (payload.devices || []).find((item) => item.sn === this.device.sn)
					if (!latest) {
						this.pruneStaleDevice(this.device.sn)
						return
					}
					this.device = Object.assign({}, this.device, latest, {
						online: latest.online === true || latest._online === true,
						status: latest.status && latest.status.status ? latest.status.status : this.device.status
					})
					const preview = uni.getStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
					if (preview && preview.sn === latest.sn) {
						uni.setStorageSync(DEVICE_DETAIL_PREVIEW_KEY, Object.assign({}, preview, { nickname: latest.nickname || '' }))
					}
				} catch (error) {
					console.warn('[device-detail] metadata refresh failed', error && (error.code || error.message))
				}
			},
			goLive() {
				if (!this.device.sn) {
					uni.showToast({ title: '设备信息暂未接入', icon: 'none' })
					return
				}
				const liveDevice = {
					sn: this.device.sn,
					nickname: this.device.nickname || '摄像头',
					status: this.device.status || '',
					online: this.device.online === true,
					role: this.device.role || 'owner',
					primaryCatId: this.device.primaryCatId || '',
					primaryCatRef: this.device.primaryCatRef || '',
					permissions: this.device.permissions || [],
					liveDiagnosticsEnabled: this.device.liveDiagnosticsEnabled === true
				}
				uni.navigateTo({
					url: '/pages/live/index?device=' + encodeURIComponent(JSON.stringify(liveDevice))
				})
			},
			goShare() {
				uni.navigateTo({ url: '/pages/profile/share-device' })
			},
			showUnavailable() {
				uni.showToast({ title: '更多设置暂未接入', icon: 'none' })
			}
		}
	}
</script>

<style>
	.device-detail-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.detail-more-button { width: 64rpx; height: 64rpx; border: 2rpx solid #D8D8D5; border-radius: 50%; background: #FFFFFF; color: #5A5A56; display: flex; align-items: center; justify-content: center; font-size: 26rpx; }
	.detail-preview { position: relative; width: 100%; height: 360rpx; overflow: hidden; background: #F1F1EF; }
	.preview-image, .preview-placeholder { width: 100%; height: 100%; }
	.preview-placeholder { display: flex; align-items: center; justify-content: center; }
	.status-badge { position: absolute; left: 32rpx; bottom: 24rpx; height: 48rpx; padding: 0 20rpx; border: 2rpx solid rgba(255,255,255,.18); border-radius: 26rpx; background: rgba(11,11,12,.72); color: #FFFFFF; display: flex; align-items: center; gap: 10rpx; font-size: 22rpx; font-weight: 600; }
	.status-dot { width: 12rpx; height: 12rpx; border-radius: 50%; background: #C4C4C0; }
	.status-dot.online { background: #3DDC74; }
	.detail-intro { min-height: 132rpx; padding: 24rpx 32rpx; box-sizing: border-box; border-bottom: 2rpx solid #E8E8E5; display: flex; align-items: center; gap: 20rpx; }
	.intro-copy { flex: 1; min-width: 0; }
	.intro-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 36rpx; line-height: 48rpx; font-weight: 650; }
	.intro-meta { display: block; margin-top: 4rpx; color: #989893; font-size: 22rpx; }
	.live-action { min-width: 168rpx; height: 72rpx; padding: 0 24rpx; box-sizing: border-box; border-radius: 36rpx; background: #141414; color: #FFFFFF; display: flex; align-items: center; justify-content: center; font-size: 26rpx; font-weight: 600; }
	.live-action.disabled { background: #D8D8D5; color: #5A5A56; }
	.settings-section { margin-top: 34rpx; padding: 0 32rpx; }
	.section-title { display: block; margin: 0 4rpx 12rpx; color: #5A5A56; font-size: 23rpx; font-weight: 600; }
	.setting-row { height: 104rpx; display: flex; align-items: center; justify-content: space-between; gap: 24rpx; border-bottom: 2rpx solid #EFEFED; }
	.setting-row:last-child { border-bottom: 0; }
	.setting-label { flex: none; font-size: 28rpx; font-weight: 550; }
	.setting-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #5A5A56; font-size: 24rpx; text-align: right; }
	.setting-value.unavailable { color: #989893; }
	.setting-trailing { min-width: 0; display: flex; align-items: center; gap: 12rpx; }
	.row-arrow { flex: none; color: #B4B4B0; font-size: 40rpx; }
	.remove-action { min-height: 104rpx; margin: 34rpx 32rpx 0; border: 2rpx solid #EDEDEB; border-radius: 36rpx; background: #FFFFFF; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.remove-action.disabled { color: #9A4A40; opacity: .56; }
	.remove-title { font-size: 27rpx; font-weight: 600; }
	.remove-note { margin-top: 4rpx; color: #989893; font-size: 21rpx; }
	.bottom-safe { height: calc(48rpx + env(safe-area-inset-bottom)); }
</style>
