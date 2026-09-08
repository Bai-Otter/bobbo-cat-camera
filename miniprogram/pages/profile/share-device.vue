<template>
	<view class="share-page">
		<bobbo-nav-bar title="共享设备" title-align="left"></bobbo-nav-bar>
		<view class="share-content">
			<view v-if="loading" class="quiet-state"><text>正在读取家庭设备...</text></view>
			<view v-else-if="!devices.length" class="quiet-state"><text class="state-title">还没有可共享的设备</text><text class="state-copy">先完成摄像头配置，再邀请家庭成员。</text></view>

			<template v-else>
				<scroll-view v-if="devices.length > 1" scroll-x class="device-tabs">
					<view class="device-tab-row">
						<view v-for="device in devices" :key="device.sn" class="device-tab" :class="{ active: device.sn === selectedSn }" @click="selectDevice(device.sn)">{{ device.nickname || '布卜布卜摄像头' }}</view>
					</view>
				</scroll-view>

				<view class="device-summary">
					<view><text class="device-name">{{ selectedDevice.nickname || '布卜布卜摄像头' }}</text><text class="device-id">{{ selectedDevice.sn }}</text></view>
					<text class="role-label">{{ isOwner ? '设备主人' : '家庭成员' }}</text>
				</view>

				<template v-if="isOwner">
					<view class="invite-panel">
						<template v-if="miniCode">
							<image class="mini-code" :src="miniCode" mode="aspectFit" />
							<text class="invite-title">微信扫码加入家庭设备</text>
							<text class="invite-expiry">{{ expiryText }}</text>
							<button class="text-button danger" @click="cancelCurrentInvite">取消这份邀请</button>
						</template>
						<template v-else>
							<view class="share-symbol"><cat-icon name="share" :size="42" color="#141414" /></view>
							<text class="invite-title">邀请一位家庭成员</text>
							<text class="invite-copy">邀请 24 小时内有效，只能领取一次。最多 5 位成员。</text>
							<button class="primary-button" :disabled="creating || memberFull" @click="createInvite">{{ memberFull ? '成员已满' : creating ? '生成中...' : '生成邀请' }}</button>
						</template>
					</view>

					<view class="section-head"><text>家庭成员</text><text>{{ members.length }}/{{ memberLimit }}</text></view>
					<view v-if="!members.length" class="empty-members">还没有成员加入</view>
					<view v-for="member in members" :key="member.openid" class="member-row">
						<image v-if="member.avatar" class="member-avatar" :src="member.avatar" mode="aspectFill" />
						<view v-else class="member-avatar fallback"><cat-icon name="profile" :size="24" color="#5A5A56" /></view>
						<view class="member-copy"><text class="member-name">{{ member.nickname || '家庭成员' }}</text><text class="member-meta">{{ joinedText(member.joinedAt) }} 加入</text></view>
						<button class="icon-action" @click="revokeMember(member)" aria-label="移除成员"><cat-icon name="logout" :size="23" color="#9A4A40" /></button>
					</view>
				</template>

				<view v-else class="member-access">
					<text class="access-title">你已加入这个家庭设备</text>
					<text class="access-copy">可查看实时画面、对讲、回放、今日数据和吃播。猫咪档案仅可查看。</text>
					<button class="secondary-button danger" @click="leaveDevice">退出共享</button>
				</view>
			</template>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { callBackend } = require('@/utils/backendClient.js')
	const { requestQrImage } = require('@/utils/qrImageLoader.js')
	const { replaceOwnedDevices } = require('@/utils/ownedDeviceCache.js')

	export default {
		components: { catIcon },
		data() {
			return { devices: [], selectedSn: '', loading: true, creating: false, members: [], invites: [], memberLimit: 5, miniCode: '', activeInvite: null, now: Date.now(), timer: null }
		},
		computed: {
			selectedDevice() { return this.devices.find((device) => device.sn === this.selectedSn) || this.devices[0] || {} },
			isOwner() { return this.selectedDevice.role !== 'member' },
			memberFull() { return this.members.length >= this.memberLimit },
			expiryText() {
				if (!this.activeInvite) return ''
				const seconds = Math.max(0, Math.ceil((this.activeInvite.expiresAt - this.now) / 1000))
				const hours = Math.floor(seconds / 3600)
				const minutes = Math.floor((seconds % 3600) / 60)
				return seconds > 0 ? `剩余 ${hours} 小时 ${minutes} 分钟` : '邀请已失效'
			}
		},
		onShow() { this.loadDevices() },
		onUnload() { if (this.timer) clearInterval(this.timer) },
		methods: {
			async loadDevices() {
				this.loading = true
				try {
					const previousSn = this.selectedSn
					const payload = await callBackend('/api/devices')
					this.devices = payload.devices || []
					replaceOwnedDevices(this.devices, uni)
					this.selectedSn = (this.devices.find((device) => device.sn === previousSn) || this.devices.find((device) => device.active) || this.devices[0] || {}).sn || ''
					if (this.isOwner && this.selectedSn) await this.loadSharing()
				} catch (error) { uni.showToast({ title: '设备读取失败', icon: 'none' }) }
				finally { this.loading = false }
			},
			async selectDevice(sn) { this.selectedSn = sn; this.resetInvite(); if (this.isOwner) await this.loadSharing() },
			async loadSharing() {
				const payload = await callBackend(`/api/devices/${encodeURIComponent(this.selectedSn)}/sharing`)
				this.members = payload.members || []
				this.invites = payload.invites || []
				this.memberLimit = Number(payload.memberLimit) || 5
			},
			resetInvite() { this.miniCode = ''; this.activeInvite = null; if (this.timer) clearInterval(this.timer); this.timer = null },
			async createInvite() {
				if (this.creating || this.memberFull) return
				this.creating = true
				try {
					const payload = await callBackend(`/api/devices/${encodeURIComponent(this.selectedSn)}/share-invites`, { method: 'POST' })
					const invite = payload.invite
					this.miniCode = await requestQrImage(`/api/devices/${encodeURIComponent(this.selectedSn)}/share-invites/${encodeURIComponent(invite.id)}/minicode`, { method: 'POST', data: { token: invite.token } })
					this.activeInvite = invite
					this.now = Date.now()
					this.timer = setInterval(() => { this.now = Date.now() }, 30 * 1000)
					await this.loadSharing()
				} catch (error) { uni.showToast({ title: '邀请生成失败', icon: 'none' }) }
				finally { this.creating = false }
			},
			async cancelCurrentInvite() { if (!this.activeInvite) return; await callBackend(`/api/devices/${encodeURIComponent(this.selectedSn)}/share-invites/${encodeURIComponent(this.activeInvite.id)}`, { method: 'DELETE' }); this.resetInvite(); await this.loadSharing() },
			revokeMember(member) { uni.showModal({ title: '移除家庭成员', content: `移除 ${member.nickname || '这位成员'} 后，其正在使用的视频与对讲会立即结束。`, confirmText: '移除', confirmColor: '#9A4A40', success: async (result) => { if (!result.confirm) return; await callBackend(`/api/devices/${encodeURIComponent(this.selectedSn)}/members/${encodeURIComponent(member.openid)}`, { method: 'DELETE' }); await this.loadSharing() } }) },
			leaveDevice() { uni.showModal({ title: '退出共享', content: '退出后将无法继续查看这个设备。', confirmText: '退出', confirmColor: '#9A4A40', success: async (result) => { if (!result.confirm) return; await callBackend(`/api/shared-devices/${encodeURIComponent(this.selectedSn)}`, { method: 'DELETE' }); uni.reLaunch({ url: '/pages/today/index' }) } }) },
			joinedText(value) { const date = new Date(Number(value) || 0); return `${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}` }
		}
	}
</script>

<style lang="scss" scoped>
	.share-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.share-content { padding: 28rpx 32rpx calc(60rpx + env(safe-area-inset-bottom)); }
	.quiet-state { min-height: 360rpx; color: #989893; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
	.state-title { color: #141414; font-size: 30rpx; font-weight: 600; }
	.state-copy { margin-top: 12rpx; font-size: 23rpx; }
	.device-tabs { width: 100%; margin-bottom: 24rpx; white-space: nowrap; }
	.device-tab-row { display: inline-flex; gap: 12rpx; }
	.device-tab { padding: 16rpx 22rpx; border: 2rpx solid #E8E8E5; border-radius: 8rpx; color: #5A5A56; font-size: 23rpx; }
	.device-tab.active { background: #141414; border-color: #141414; color: #FFFFFF; }
	.device-summary { padding: 24rpx 0 30rpx; border-bottom: 2rpx solid #E8E8E5; display: flex; align-items: center; justify-content: space-between; }
	.device-name, .device-id { display: block; }
	.device-name { font-size: 31rpx; font-weight: 650; }
	.device-id { margin-top: 6rpx; color: #989893; font-size: 20rpx; }
	.role-label { color: #5A5A56; font-size: 22rpx; }
	.invite-panel { padding: 52rpx 36rpx 38rpx; display: flex; flex-direction: column; align-items: center; text-align: center; }
	.share-symbol { width: 96rpx; height: 96rpx; border-radius: 50%; background: #E8E8E5; display: flex; align-items: center; justify-content: center; }
	.mini-code { width: 420rpx; height: 420rpx; display: block; }
	.invite-title { margin-top: 24rpx; font-size: 29rpx; font-weight: 650; }
	.invite-copy, .invite-expiry { max-width: 540rpx; margin-top: 12rpx; color: #989893; font-size: 22rpx; line-height: 34rpx; }
	.primary-button, .secondary-button { width: 100%; min-height: 86rpx; margin-top: 32rpx; border-radius: 14rpx; display: flex; align-items: center; justify-content: center; font-size: 27rpx; }
	.primary-button { background: #141414; color: #FFFFFF; }
	.primary-button[disabled] { background: #C4C4C0; }
	.primary-button::after, .secondary-button::after, .text-button::after, .icon-action::after { border: 0; }
	.text-button { margin-top: 18rpx; padding: 16rpx; border: 0; background: transparent; font-size: 23rpx; }
	.danger { color: #9A4A40; }
	.section-head { padding: 28rpx 0 14rpx; border-top: 2rpx solid #E8E8E5; display: flex; justify-content: space-between; color: #5A5A56; font-size: 22rpx; }
	.empty-members { padding: 38rpx 0; color: #989893; font-size: 23rpx; text-align: center; }
	.member-row { min-height: 104rpx; border-bottom: 2rpx solid #E8E8E5; display: flex; align-items: center; }
	.member-avatar { width: 64rpx; height: 64rpx; border-radius: 50%; }
	.member-avatar.fallback { background: #E8E8E5; display: flex; align-items: center; justify-content: center; }
	.member-copy { min-width: 0; flex: 1; margin-left: 18rpx; }
	.member-name, .member-meta { display: block; }
	.member-name { font-size: 26rpx; }
	.member-meta { margin-top: 4rpx; color: #989893; font-size: 20rpx; }
	.icon-action { width: 72rpx; height: 72rpx; margin: 0; padding: 0; border: 0; background: transparent; display: flex; align-items: center; justify-content: center; }
	.member-access { padding: 64rpx 8rpx; text-align: left; }
	.access-title { display: block; font-size: 31rpx; font-weight: 650; }
	.access-copy { display: block; margin-top: 16rpx; color: #5A5A56; font-size: 24rpx; line-height: 40rpx; }
	.secondary-button { margin-top: 50rpx; background: #FFFFFF; border: 2rpx solid #E8E8E5; }
</style>
