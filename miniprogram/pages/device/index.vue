<template>
	<view class="device-page">
		<bobbo-nav-bar :title="navTitle" title-align="left" />

		<view class="device-content" v-if="devices.length > 0">
			<view
				class="featured-device"
				@click="tapDevice(devices[0])"
				@longpress="showActionSheet(devices[0], 0)"
			>
				<view class="featured-preview">
					<image v-if="devices[0].coverUrl" class="cover-image" :src="devices[0].coverUrl" mode="aspectFill" />
					<view v-else class="cover-placeholder">
						<cat-icon name="camera" :size="62" color="#989893" />
					</view>
					<view class="preview-status">
						<view class="status-dot" :class="{ online: devices[0]._statusState === 'online' }"></view>
						<text>{{ deviceStatusLabel(devices[0]) }}</text>
					</view>
				</view>
				<view class="featured-copy">
					<view class="featured-heading">
						<text class="featured-name">{{ devices[0].nickname || '摄像头' }}</text>
						<view class="more-button" @click.stop="showActionSheet(devices[0], 0)">
							<text class="more-dots">···</text>
						</view>
					</view>
					<text class="device-sn">SN · {{ devices[0].sn }}</text>
					<text class="device-meta">{{ formatCoverMeta(devices[0]) }}</text>
				</view>
			</view>

			<view class="other-section" v-if="additionalDevices.length > 0">
				<text class="section-label">其他设备</text>
				<view
					class="compact-device"
					v-for="(item, idx) in additionalDevices"
					:key="item.sn"
					@click="tapDevice(item)"
					@longpress="showActionSheet(item, idx + 1)"
				>
					<view class="compact-thumb">
						<image v-if="item.coverUrl" class="cover-image" :src="item.coverUrl" mode="aspectFill" />
						<view v-else class="cover-placeholder"><cat-icon name="camera" :size="34" color="#989893" /></view>
					</view>
					<view class="compact-copy">
						<text class="compact-name">{{ item.nickname || '摄像头' }}</text>
						<view class="compact-meta">
							<view class="status-dot" :class="{ online: item._statusState === 'online' }"></view>
							<text>{{ deviceStatusLabel(item) }} · {{ item.sn }}</text>
						</view>
					</view>
					<view class="compact-more" @click.stop="showActionSheet(item, idx + 1)"><text>···</text></view>
					<text class="device-arrow">›</text>
				</view>
			</view>
		</view>

		<view class="empty-state" v-else-if="!isLoading">
			<view class="empty-icon"><cat-icon name="camera" :size="78" color="#989893" /></view>
			<text class="empty-title">还没有设备</text>
			<text class="empty-desc">添加摄像头后，即可在这里查看设备状态。</text>
		</view>

		<view class="loading-state" v-else>
			<text class="loading-text">正在加载设备...</text>
		</view>
		<view class="add-device-row" @click="goAddDevice">
			<view class="add-device-icon"><text>+</text></view>
			<view class="add-device-copy">
				<text class="add-device-title">添加设备</text>
				<text class="add-device-note">扫码或输入编号，也可接受分享</text>
			</view>
			<text class="device-arrow">›</text>
		</view>
		<text class="privacy-note">设备只会出现在已授权的家庭账号中。</text>
		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	import bobboNavBar from '@/components/bobbo-nav-bar/bobbo-nav-bar.vue'
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { callDemoData } = require('@/utils/demoCloud.js')
	const { buildOwnedDeviceCards, selectDirectLiveSdkDevices } = require('@/utils/deviceMediaState.js')
	const { readOwnedDevices, refreshOwnedDevices, replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')
	const { fetchAccessibleDeviceStatuses, mergeAccessibleDeviceStatuses } = require('@/utils/accessibleDeviceStatus.js')

	const REFRESH_INTERVAL_MS = 15000
	const DEVICE_DETAIL_PREVIEW_KEY = 'bobbo_device_detail_preview'
	const FACTORY_RESET_OPTIONS = {
		Account: true,
		Alarm: true,
		CommPtz: true,
		Encode: true,
		General: true,
		NetCommon: true,
		NetServer: true,
		Preview: true,
		Record: true,
		XMModeSwitch: true,
		CameraPARAM: true
	}

	export default {
		components: { catIcon, bobboNavBar },
		data() {
			return {
				devices: [],
				isLoading: false,
				refreshTimer: null,
				refreshingStatus: false,
				renamingSn: '',
				sharedAccessFresh: false
			}
		},
		computed: {
			navTitle() {
				return `设备管理 · ${this.devices.length} 台`
			},
			additionalDevices() {
				return this.devices.slice(1)
			}
		},
		onShow() {
			if (!this.ensureAppAuth()) return
			this.restoreCachedDevices()
			this.loadDevices()
			this.startRefreshTimer()
		},
		onHide() {
			this.stopRefreshTimer()
		},
		onUnload() {
			this.stopRefreshTimer()
		},
		methods: {
			deviceStatusLabel(item) {
				if (item && item._statusState === 'online') return '在线'
				if (item && item._statusState === 'offline') return '离线'
				return '状态未知'
			},
			restoreCachedDevices() {
				const cached = readOwnedDevices(uni)
				if (cached.length === 0) return false
				this.devices = buildOwnedDeviceCards({ devices: cached, now: Date.now() })
				return true
			},
			ensureAppAuth() {
				return !!ensureAppSession({ message: '请先登录' })
			},
			startRefreshTimer() {
				this.stopRefreshTimer()
				this.refreshTimer = setInterval(() => this.refreshDeviceStatuses(), REFRESH_INTERVAL_MS)
			},
			stopRefreshTimer() {
				if (this.refreshTimer) {
					clearInterval(this.refreshTimer)
					this.refreshTimer = null
				}
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
						if (!this.JLWXSDK || typeof this.JLWXSDK[method] !== 'function') {
							throw new Error(`JLWXSDK.${method} is unavailable`)
						}
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
			callSdkWithToken(method, payload, token, timeoutMs = 12000) {
				return new Promise((resolve, reject) => {
					let settled = false
					const timer = setTimeout(() => {
						if (settled) return
						settled = true
						reject(new Error(`${method} timeout after ${timeoutMs}ms`))
					}, timeoutMs)
					try {
						if (!this.JLWXSDK || typeof this.JLWXSDK[method] !== 'function') {
							throw new Error(`JLWXSDK.${method} is unavailable`)
						}
						this.JLWXSDK[method](payload, token, (result) => {
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
			extractTokenList(result) {
				const data = result && result.data ? result.data : result
				if (Array.isArray(data)) return data
				if (data && Array.isArray(data.tokens)) return data.tokens
				if (data && Array.isArray(data.deviceTokens)) return data.deviceTokens
				return []
			},
			extractStatusList(result) {
				const data = result && result.data ? result.data : result
				if (Array.isArray(data)) return data
				if (data && Array.isArray(data.statusList)) return data.statusList
				if (data && Array.isArray(data.devices)) return data.devices
				return []
			},
			normalizeStatus(raw = {}) {
				const statusValue = String(raw.status || raw.Status || '').trim()
				const online = statusValue === 'online' || raw.online === true || raw.Online === true
				return {
					status: online ? 'online' : statusValue || 'offLine',
					statusDesc: online ? '在线' : '离线',
					raw
				}
			},
			normalizeDevice(item) {
				const status = item.status && typeof item.status === 'object' ? item.status : this.normalizeStatus(item.status || {})
				const online = item._online || item.online || item.status === 'online' || status.status === 'online'
				return {
					...item,
					token: item.token || item.deviceToken || '',
					deviceToken: item.deviceToken || item.token || '',
					username: item.username || 'admin',
					nickname: item.nickname || '摄像头',
					status,
					_online: !!online
				}
			},
			async fetchOwnedDevicesFromBackend() {
				const result = await callBackend('/api/devices')
				return Array.isArray(result.devices) ? result.devices : []
			},
			async getDeviceCoversAsync(sns) {
				return callDemoData('getDeviceCovers', { sns })
			},
			buildCoverMapFromDevices(list) {
				return list.reduce((acc, item) => {
					if (item && item.sn && item.coverUrl) {
						acc[item.sn] = { coverUrl: item.coverUrl, updatedAt: item.coverUpdatedAt || 0 }
					}
					return acc
				}, {})
			},
			mergeTokensIntoDevices(devices, tokenRows) {
				const tokenBySn = tokenRows.reduce((acc, row) => {
					if (row && row.sn) acc[row.sn] = row.token || row.deviceToken || ''
					return acc
				}, {})
				return devices.map((item) => this.normalizeDevice({
					...item,
					token: tokenBySn[item.sn] || item.token || item.deviceToken || '',
					deviceToken: tokenBySn[item.sn] || item.deviceToken || item.token || ''
				}))
			},
			mergeStatusesIntoDevices(devices, statusRows) {
				const statusBySn = statusRows.reduce((acc, row) => {
					const sn = row && (row.uuid || row.sn || row.deviceSn)
					if (sn) acc[sn] = this.normalizeStatus(row)
					return acc
				}, {})
				return devices.map((item) => {
					const status = statusBySn[item.sn] || item.status || this.normalizeStatus({})
					return this.normalizeDevice({
						...item,
						status,
						_online: status.status === 'online'
					})
				})
			},
			async fetchDeviceTokenRowsFromSdk(devices) {
				const sns = devices.map((item) => item.sn).filter(Boolean)
				if (sns.length === 0) return []
				try {
					const result = await this.callSdk('getDeviceToken', { sns })
					return this.extractTokenList(result)
				} catch (error) {
					console.log('[device] getDeviceToken failed', error)
					return []
				}
			},
			async resolveDeviceToken(item) {
				const existing = String(item && (item.token || item.deviceToken) || '').trim()
				if (existing) return existing
				if (!item || !item.sn) return ''
				const tokenRows = await this.fetchDeviceTokenRowsFromSdk([item])
				const [resolved] = buildOwnedDeviceCards({ devices: [item], tokenRows, now: Date.now() })
				const token = String(resolved && (resolved.token || resolved.deviceToken) || '').trim()
				if (!token) return ''

				const index = this.devices.findIndex((device) => device.sn === item.sn)
				if (index >= 0) {
					this.devices[index] = Object.assign({}, this.devices[index], {
						token,
						deviceToken: token
					})
					this.devices = [...this.devices]
				}
				console.log('[device] device token resolved on demand', { sn: item.sn })
				return token
			},
			async fetchDeviceStatusRowsFromSdk(devices) {
				const tokens = devices.map((item) => item.token).filter(Boolean)
				if (tokens.length === 0) return []
				try {
					const result = await this.callSdk('getNewDeviceStatus', { token: tokens })
					return this.extractStatusList(result)
				} catch (error) {
					console.log('[device] getNewDeviceStatus failed', error)
					return []
				}
			},
			async loadDevices() {
				if (!this.ensureAppAuth()) return
				this.isLoading = this.devices.length === 0
				try {
					const refreshed = await refreshOwnedDevices(
						() => this.fetchOwnedDevicesFromBackend(),
						uni
					)
					if (!refreshed.refreshed) {
						console.warn('[device] backend device refresh failed, using cache', refreshed.error)
					}
					this.sharedAccessFresh = refreshed.refreshed
					const fetchedDevices = refreshed.devices
					const cachedBySn = readOwnedDevices(uni).reduce((map, item) => {
						map[item.sn] = item
						return map
					}, {})
					const ownedDevices = fetchedDevices.map((item) => Object.assign({}, cachedBySn[item.sn] || {}, item))
					if (ownedDevices.length === 0) {
						this.devices = []
						replaceOwnedDevices([], uni)
						return
					}
					const sdkDevices = selectDirectLiveSdkDevices(ownedDevices, { sharedAccessFresh: this.sharedAccessFresh })
					const tokenRows = await this.fetchDeviceTokenRowsFromSdk(sdkDevices)
					const sns = ownedDevices.map((item) => item.sn)
					const [coverResult] = await Promise.all([this.getDeviceCoversAsync(sns)])
					const coversBySn = coverResult && coverResult.ok ? coverResult.coversBySn || {} : {}
					const cards = buildOwnedDeviceCards({ devices: ownedDevices, tokenRows, coversBySn, now: Date.now() })
					const statuses = await fetchAccessibleDeviceStatuses(cards, callBackend)
					this.devices = mergeAccessibleDeviceStatuses(cards, statuses)
					replaceOwnedDevices(this.devices, uni)
					this.refreshDeviceStatuses()
				} catch (error) {
					console.log('[device] loadDevices failed', error)
				} finally {
					this.isLoading = false
				}
			},
			async refreshDeviceStatuses() {
				if (this.refreshingStatus || this.devices.length === 0) return
				this.refreshingStatus = true
				try {
					const previousCoverMap = this.buildCoverMapFromDevices(this.devices)
					const sdkDevices = selectDirectLiveSdkDevices(this.devices, { sharedAccessFresh: this.sharedAccessFresh })
					const tokenRows = await this.fetchDeviceTokenRowsFromSdk(sdkDevices)
					const statuses = await fetchAccessibleDeviceStatuses(this.devices, callBackend)
					const coverResult = await this.getDeviceCoversAsync(this.devices.map((item) => item.sn))
					const coversBySn = coverResult && coverResult.ok
						? Object.assign({}, previousCoverMap, coverResult.coversBySn || {})
						: previousCoverMap
					const cards = buildOwnedDeviceCards({ devices: this.devices, tokenRows, coversBySn, now: Date.now() })
					this.devices = mergeAccessibleDeviceStatuses(cards, statuses)
					replaceOwnedDevices(this.devices, uni)
				} finally {
					this.refreshingStatus = false
				}
			},
			formatCoverMeta(item) {
				if (!item.coverUpdatedAt) return item.token ? '等待直播后生成封面' : '设备令牌未就绪'
				return item.isCoverStale ? '封面较早，请进入直播更新' : '画面封面已就绪'
			},
			tapDevice(item) {
				if (!this.ensureAppAuth()) return
				uni.setStorageSync('lastViewedDeviceSn', item.sn)
				const preview = {
					sn: item.sn,
					nickname: item.nickname || '摄像头',
					online: !!item._online,
					status: item._statusState || 'unknown',
					coverUrl: item.coverUrl || '',
					role: item.role || 'owner',
					primaryCatId: item.primaryCatId || '',
					primaryCatRef: item.primaryCatRef || '',
					permissions: item.permissions || []
				}
				if (typeof item.location === 'string' && item.location.trim()) preview.location = item.location.trim()
				uni.setStorageSync(DEVICE_DETAIL_PREVIEW_KEY, preview)
				uni.navigateTo({
					url: '/pages/device/detail?sn=' + encodeURIComponent(item.sn)
				})
			},
			showActionSheet(item, idx) {
				if (item && item.role === 'member') {
					uni.showToast({ title: '共享设备仅可查看', icon: 'none' })
					return
				}
				uni.showActionSheet({
					itemList: ['修改设备名称', '恢复出厂设置', '解绑设备'],
					itemColor: '#141414',
					success: (res) => {
						if (res.tapIndex === 0) this.editNickname(item, idx)
						if (res.tapIndex === 1) this.confirmFactoryReset(item)
						if (res.tapIndex === 2) this.confirmUnbindDevice(item)
					}
				})
			},
			editNickname(item, idx) {
				if (!item || item.role === 'member' || this.renamingSn) return
				uni.showModal({
					title: '修改名称',
					editable: true,
					placeholderText: item.nickname || '摄像头',
					success: async (res) => {
						if (!res.confirm) return
						const newName = (res.content || '').trim()
						if (!newName) {
							uni.showToast({ title: '名称不能为空', icon: 'none' })
							return
						}
						if (newName.length > 80) {
							uni.showToast({ title: '名称最多 80 个字符', icon: 'none' })
							return
						}
						await this.saveDeviceNickname(item, idx, newName)
					}
				})
			},
			async saveDeviceNickname(item, idx, nickname) {
				if (this.renamingSn) return false
				this.renamingSn = item.sn
				uni.showLoading({ title: '保存中...' })
				try {
					const payload = await callBackend('/api/devices/' + encodeURIComponent(item.sn) + '/nickname', {
						method: 'PUT',
						data: { nickname },
						syncSource: 'device-manager'
					})
					const saved = payload && payload.device ? payload.device : { sn: item.sn, nickname }
					const next = Object.assign({}, item, saved)
					const currentIndex = this.devices.findIndex((device) => device.sn === item.sn)
					const targetIndex = currentIndex >= 0 ? currentIndex : idx
					if (targetIndex >= 0) this.devices.splice(targetIndex, 1, next)
					this.devices = [...this.devices]
					replaceOwnedDevices(this.devices, uni)
					const preview = uni.getStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
					if (preview && preview.sn === item.sn) {
						uni.setStorageSync(DEVICE_DETAIL_PREVIEW_KEY, Object.assign({}, preview, { nickname: next.nickname }))
					}
					uni.showToast({ title: '名称已保存', icon: 'success' })
					return true
				} catch (error) {
					console.log('[device] nickname save failed', {
						code: error && error.code,
						requestId: error && error.requestId
					})
					uni.showToast({ title: getBackendErrorMessage(error, '名称保存失败，请稍后重试'), icon: 'none' })
					return false
				} finally {
					uni.hideLoading()
					this.renamingSn = ''
				}
			},
			confirmFactoryReset(item) {
				uni.showModal({
					title: '恢复出厂设置',
					content: '确定要恢复“' + (item.nickname || item.sn) + '”的出厂设置吗？设备会清空网络和配置并重启。',
					confirmColor: '#9A4A40',
					success: (res) => {
						if (res.confirm) this.factoryResetDevice(item)
					}
				})
			},
			buildFactoryResetPayload() {
				return {
					Name: 'OPDefaultConfig',
					OPDefaultConfig: { ...FACTORY_RESET_OPTIONS }
				}
			},
			isDeviceCommandSuccess(result) {
				return !!(
					(result && result.code === 2000) ||
					(result && result.data && result.data.code === 2000) ||
					(result && result.data && result.data.Ret === 100) ||
					(result && result.data && result.data.data && result.data.data.Ret === 100)
				)
			},
			async factoryResetDevice(item) {
				if (!item || item.role === 'member') return false
				uni.showLoading({ title: '恢复中...' })
				try {
					const token = await this.resolveDeviceToken(item)
					if (!token) {
						uni.hideLoading()
						uni.showToast({ title: '设备令牌获取失败，请稍后重试', icon: 'none' })
						console.log('[device] factory reset token unavailable', { sn: item && item.sn })
						return false
					}
					const result = await this.callSdkWithToken('opdev', this.buildFactoryResetPayload(), token)
					uni.hideLoading()
					uni.showToast({ title: '已恢复并解绑', icon: 'success' })
					return true
				} catch (error) {
					uni.hideLoading()
					console.log('[device] factory reset exception', error)
					const title = error && error.stage === 'unbind'
						? '设备已重置，云端解绑失败'
						: error && error.stage === 'remove'
							? '已解绑，设备档案清理失败'
							: '恢复出厂失败'
					uni.showToast({ title, icon: 'none', duration: 3000 })
					return false
				}
			},
			confirmUnbindDevice(item) {
				uni.showModal({
					title: '解绑设备',
					content: '确定要解绑“' + (item.nickname || item.sn) + '”吗？解绑后需要重新配网才能使用。',
					confirmText: '确认解绑',
					confirmColor: '#9A4A40',
					success: (res) => {
						if (res.confirm) this.unbindDevice(item)
					}
				})
			},
			clearUnboundDeviceCache(item) {
				this.devices = this.devices.filter((device) => device.sn !== item.sn)
				replaceOwnedDevices(this.devices, uni)
				if (uni.getStorageSync('lastViewedDeviceSn') === item.sn) {
					uni.removeStorageSync('lastViewedDeviceSn')
				}
				const preview = uni.getStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
				if (preview && preview.sn === item.sn) uni.removeStorageSync(DEVICE_DETAIL_PREVIEW_KEY)
			},
			async unbindDevice(item) {
				if (!item || item.role === 'member') return false
				uni.showLoading({ title: '解绑中...' })
				try {
					const token = await this.resolveDeviceToken(item)
					if (!token) throw new Error('DEVICE_TOKEN_UNAVAILABLE')
					const result = await this.callSdkWithToken('unbindDevice', { sn: item.sn }, token)
					if (!this.isDeviceCommandSuccess(result)) {
						const error = new Error((result && result.msg) || 'DEVICE_VENDOR_UNBIND_FAILED')
						error.result = result
						throw error
					}
					await callBackend('/api/devices/' + encodeURIComponent(item.sn), { method: 'DELETE' })
					this.clearUnboundDeviceCache(item)
					uni.hideLoading()
					uni.showToast({ title: '设备已解绑', icon: 'success' })
					return true
				} catch (error) {
					uni.hideLoading()
					console.log('[device] unbind failed', error && error.result ? error.result : error)
					uni.showToast({ title: '解绑失败，请稍后重试', icon: 'none' })
					return false
				}
			},
			goAddDevice() {
				if (!this.ensureAppAuth()) return
				uni.navigateTo({ url: '/pages/bind/addDevice' })
			}
		}
	}
</script>

<style>
	.device-page { min-height: 100vh; box-sizing: border-box; background: #FBFBFA; color: #141414; }
	.device-content { padding: 32rpx 48rpx 0; }
	.featured-device { overflow: hidden; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 36rpx; }
	.featured-preview { position: relative; width: 100%; height: 224rpx; overflow: hidden; background: #F1F1EF; }
	.cover-image, .cover-placeholder { width: 100%; height: 100%; }
	.cover-placeholder { display: flex; align-items: center; justify-content: center; background: #F1F1EF; }
	.preview-status { position: absolute; left: 20rpx; bottom: 18rpx; height: 44rpx; padding: 0 18rpx; border: 2rpx solid rgba(255,255,255,.18); border-radius: 24rpx; background: rgba(11,11,12,.72); color: #FFFFFF; display: flex; align-items: center; gap: 10rpx; font-size: 22rpx; }
	.status-dot { width: 12rpx; height: 12rpx; flex: none; border-radius: 50%; background: #C4C4C0; }
	.status-dot.online { background: #3DDC74; }
	.featured-copy { padding: 24rpx 26rpx 26rpx; }
	.featured-heading { display: flex; align-items: center; min-width: 0; }
	.featured-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 34rpx; line-height: 46rpx; font-weight: 650; }
	.more-button { width: 56rpx; height: 48rpx; margin-right: -10rpx; display: flex; align-items: center; justify-content: center; }
	.more-dots { color: #5A5A56; font-size: 28rpx; line-height: 1; }
	.device-sn, .device-meta { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.device-sn { margin-top: 4rpx; color: #5A5A56; font-size: 23rpx; }
	.device-meta { margin-top: 8rpx; color: #989893; font-size: 23rpx; }
	.other-section { margin-top: 36rpx; }
	.section-label { display: block; margin: 0 4rpx 14rpx; color: #5A5A56; font-size: 24rpx; font-weight: 600; }
	.compact-device { min-height: 136rpx; margin-top: 14rpx; padding: 16rpx 18rpx; box-sizing: border-box; border: 2rpx solid #EDEDEB; border-radius: 36rpx; background: #FFFFFF; display: flex; align-items: center; }
	.compact-thumb { width: 104rpx; height: 104rpx; flex: none; overflow: hidden; border-radius: 20rpx; background: #F1F1EF; }
	.compact-copy { flex: 1; min-width: 0; margin-left: 20rpx; }
	.compact-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 29rpx; font-weight: 600; }
	.compact-meta { margin-top: 8rpx; color: #989893; display: flex; align-items: center; gap: 10rpx; font-size: 22rpx; }
	.compact-meta text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.compact-more { width: 48rpx; height: 64rpx; color: #5A5A56; display: flex; align-items: center; justify-content: center; font-size: 25rpx; }
	.device-arrow { flex: none; color: #B4B4B0; font-size: 42rpx; font-weight: 300; }
	.empty-state, .loading-state { min-height: 360rpx; margin: 32rpx 48rpx 0; padding: 36rpx 48rpx; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; }
	.empty-icon { width: 120rpx; height: 120rpx; margin-bottom: 24rpx; border-radius: 50%; background: #F1F1EF; display: flex; align-items: center; justify-content: center; }
	.empty-title { font-size: 32rpx; font-weight: 650; }
	.empty-desc { max-width: 470rpx; margin-top: 10rpx; color: #989893; font-size: 24rpx; line-height: 36rpx; text-align: center; }
	.loading-text { color: #989893; font-size: 26rpx; }
	.add-device-row { min-height: 112rpx; margin: 0 48rpx; padding: 12rpx 4rpx; box-sizing: border-box; border-top: 2rpx solid #E8E8E5; border-bottom: 2rpx solid #E8E8E5; display: flex; align-items: center; }
	.add-device-icon { width: 72rpx; height: 72rpx; flex: none; border-radius: 18rpx; background: #F1F1EF; color: #141414; display: flex; align-items: center; justify-content: center; font-size: 38rpx; font-weight: 300; }
	.add-device-icon text { margin-top: -4rpx; }
	.add-device-copy { flex: 1; min-width: 0; margin-left: 18rpx; }
	.add-device-title { display: block; font-size: 27rpx; font-weight: 600; }
	.add-device-note { display: block; margin-top: 3rpx; color: #989893; font-size: 21rpx; line-height: 30rpx; }
	.privacy-note { display: block; margin: 18rpx 48rpx 0; color: #B4B4B0; font-size: 21rpx; line-height: 30rpx; text-align: center; }
	.bottom-safe { height: calc(48rpx + env(safe-area-inset-bottom)); }
</style>
