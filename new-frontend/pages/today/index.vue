<template>
	<view class="today-page">
		<!-- 顶部标题栏 -->
		<view class="page-header">
			<text class="page-title">今日</text>
			<view class="bell-btn" @click="goNotifications">
				<text class="bell-icon">🔔</text>
				<view class="bell-dot" v-if="hasUnread"></view>
			</view>
		</view>

		<!-- 宠物状态卡片 -->
		<view class="pet-card" @click="goDeviceDetail">
			<image class="pet-avatar" :src="pet.avatar" mode="aspectFill" />
			<view class="pet-info">
				<view class="pet-name-row">
					<text class="pet-name">{{pet.name}}</text>
					<view class="status-tag" :class="{online: device.online}">
						<view class="status-dot"></view>
						<text class="status-text">{{device.online ? '在线' : '离线'}}</text>
					</view>
				</view>
				<view class="pet-eat-row">
					<text class="eat-label">今天已吃</text>
					<text class="eat-count">{{todayEatCount}}</text>
					<text class="eat-label">次</text>
				</view>
			</view>
			<image class="device-thumb" :src="deviceImg" mode="aspectFit" />
			<text class="card-arrow">›</text>
		</view>

		<!-- 状态指标四宫格 -->
		<view class="stat-grid">
			<view class="stat-item">
				<text class="stat-icon">🍽️</text>
				<view class="stat-text">
					<text class="stat-label">设备在线</text>
					<text class="stat-value" :class="{good: device.online}">{{device.online ? '状态良好' : '已离线'}}</text>
				</view>
			</view>
			<view class="stat-item">
				<text class="stat-icon">🕐</text>
				<view class="stat-text">
					<text class="stat-label">最新动态</text>
					<text class="stat-value">{{latestTime}}</text>
				</view>
			</view>
			<view class="stat-item" @click="switchToClips">
				<text class="stat-icon">🎬</text>
				<view class="stat-text">
					<text class="stat-label">今日片段</text>
					<text class="stat-value">{{clipCount}} 条</text>
				</view>
			</view>
			<view class="stat-item">
				<text class="stat-icon">🔋</text>
				<view class="stat-text">
					<text class="stat-label">电量</text>
					<text class="stat-value">{{device.battery}}%</text>
				</view>
			</view>
		</view>

		<!-- 今日精选 -->
		<view class="section-header">
			<text class="section-title">今日精选</text>
			<view class="section-more" @click="switchToClips">
				<text class="more-text">每日精选片段</text>
				<text class="more-arrow">›</text>
			</view>
		</view>

		<view class="featured-card" @click="playFeatured">
			<image class="featured-img" :src="featured.cover" mode="aspectFill" />
			<view class="featured-play">
				<text class="play-icon">▶</text>
			</view>
			<view class="featured-duration">
				<text class="duration-text">▷ {{featured.duration}} 秒</text>
			</view>
		</view>

		<!-- 实时画面入口 -->
		<view class="live-entry" @click="goLive">
			<view class="live-left">
				<view class="live-title-row">
					<text class="live-title">实时画面</text>
					<view class="status-tag" :class="{online: device.online}">
						<view class="status-dot"></view>
						<text class="status-text">{{device.online ? '在线' : '离线'}}</text>
					</view>
				</view>
				<text class="live-desc">看看{{pet.name}}此刻的状态</text>
			</view>
			<view class="live-right">
				<image class="live-thumb" :src="liveThumb" mode="aspectFill" />
				<view class="live-badge">
					<text class="live-badge-icon">📺</text>
				</view>
			</view>
			<text class="card-arrow">›</text>
		</view>

		<!-- 吃饭时间线 -->
		<view class="section-header">
			<text class="section-title">吃饭时间线</text>
			<view class="section-more" @click="goAllRecords">
				<text class="more-text">全部记录</text>
				<text class="more-arrow">›</text>
			</view>
		</view>

		<view class="timeline-card">
			<view class="timeline-item" v-for="(meal, idx) in meals" :key="idx" @click="goMealDetail(meal)">
				<view class="timeline-check">
					<text class="check-icon">✓</text>
				</view>
				<image class="meal-thumb" :src="meal.thumb" mode="aspectFill" />
				<text class="meal-time">{{meal.time}}</text>
				<text class="meal-name">{{meal.name}}</text>
				<view class="meal-action">
					<text class="meal-action-text">{{meal.actionText}}</text>
					<text class="meal-arrow">›</text>
				</view>
			</view>
		</view>

		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	export default {
		data() {
			return {
				hasUnread: true,
				// 宠物信息（假数据，后续从用户配置读取）
				pet: {
					name: '奶油',
					avatar: '/static/images/cat-avatar.png'
				},
				// 设备信息（部分真实：online/battery 后续接 getNewDeviceStatus）
				device: {
					online: true,
					battery: 86,
					sn: '',
					token: ''
				},
				deviceImg: '/static/images/device-bowl.png',
				liveThumb: '/static/images/live-thumb.png',
				latestTime: '18:27',
				clipCount: 3,
				todayEatCount: 3,
				// 今日精选（假数据）
				featured: {
					cover: '/static/images/featured-cover.png',
					duration: 24
				},
				// 吃饭时间线（假数据，后续接 AI 进食检测）
				meals: [
					{ time: '18:27', name: '饱足的一餐', thumb: '/static/images/meal-1.png', actionText: '已记录' },
					{ time: '12:43', name: '美味的一餐', thumb: '/static/images/meal-2.png', actionText: '查看' },
					{ time: '07:58', name: '活力的一餐', thumb: '/static/images/meal-3.png', actionText: '详情' }
				]
			}
		},
		onShow() {
			this.loadDevice()
		},
		methods: {
			// 加载真实设备数据（接现有 SDK 逻辑）
			loadDevice() {
				this.JLWXSDK.getDeviceList({ page: 1, limit: 1 }, (result) => {
					if (result.code === 2000 && result.data && result.data.deviceList && result.data.deviceList.length > 0) {
						const dev = result.data.deviceList[0]
						this.device.sn = dev.sn
						if (dev.nickname) this.pet.name = dev.nickname
						// 拿 token + 状态
						this.JLWXSDK.getDeviceToken({ sns: [dev.sn] }, (tokenRes) => {
							if (tokenRes.code === 2000 && tokenRes.data && tokenRes.data.length > 0) {
								this.device.token = tokenRes.data[0].token
								this.JLWXSDK.getNewDeviceStatus({ token: [this.device.token] }, (statusRes) => {
									if (statusRes.code === 2000 && statusRes.data && statusRes.data.length > 0) {
										const s = statusRes.data[0]
										this.device.online = s.status === 'online'
									}
								})
							}
						})
					}
					// 没设备时保持假数据装样子
				})
			},
			goLive() {
				if (!this.device.sn) {
					uni.showToast({ title: '请先在「我的」中配网添加设备', icon: 'none' })
					return
				}
				uni.navigateTo({
					url: '/pages/live/index?device=' + encodeURIComponent(JSON.stringify(this.device))
				})
			},
			switchToClips() {
				uni.switchTab({ url: '/pages/clips/index' })
			},
			playFeatured() {
				uni.showToast({ title: '精选片段即将上线', icon: 'none' })
			},
			goDeviceDetail() {
				if (this.device.sn) this.goLive()
			},
			goNotifications() {
				uni.showToast({ title: '暂无新通知', icon: 'none' })
			},
			goAllRecords() {
				this.switchToClips()
			},
			goMealDetail(meal) {
				uni.showToast({ title: meal.time + ' ' + meal.name, icon: 'none' })
			}
		}
	}
</script>

<style>
	.today-page {
		min-height: 100vh;
		background: #F2EDE4;
		padding: 0 32rpx;
	}

	/* 顶部标题 */
	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 40rpx 0 32rpx;
	}
	.page-title {
		font-size: 56rpx;
		font-weight: 700;
		color: #2B2620;
		letter-spacing: 4rpx;
	}
	.bell-btn {
		width: 80rpx;
		height: 80rpx;
		border-radius: 50%;
		background: #FBF8F2;
		display: flex;
		align-items: center;
		justify-content: center;
		position: relative;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.08);
	}
	.bell-icon { font-size: 34rpx; }
	.bell-dot {
		position: absolute;
		top: 18rpx;
		right: 20rpx;
		width: 16rpx;
		height: 16rpx;
		border-radius: 50%;
		background: #E8A23D;
		border: 3rpx solid #FBF8F2;
	}

	/* 宠物卡片 */
	.pet-card {
		background: #FBF8F2;
		border-radius: 32rpx;
		padding: 32rpx;
		display: flex;
		align-items: center;
		position: relative;
		box-shadow: 0 6rpx 24rpx rgba(140, 120, 90, 0.08);
		margin-bottom: 24rpx;
	}
	.pet-avatar {
		width: 112rpx;
		height: 112rpx;
		border-radius: 50%;
		background: #EDE6D8;
		flex-shrink: 0;
	}
	.pet-info {
		flex: 1;
		margin-left: 28rpx;
	}
	.pet-name-row {
		display: flex;
		align-items: center;
		margin-bottom: 14rpx;
	}
	.pet-name {
		font-size: 40rpx;
		font-weight: 700;
		color: #2B2620;
		margin-right: 16rpx;
	}
	.status-tag {
		display: flex;
		align-items: center;
		background: #EDE6D8;
		border-radius: 24rpx;
		padding: 4rpx 16rpx 4rpx 12rpx;
	}
	.status-tag.online { background: rgba(122, 165, 122, 0.16); }
	.status-dot {
		width: 12rpx;
		height: 12rpx;
		border-radius: 50%;
		background: #B0A48E;
		margin-right: 8rpx;
	}
	.status-tag.online .status-dot { background: #6FA86F; }
	.status-text {
		font-size: 24rpx;
		color: #8A7E68;
	}
	.status-tag.online .status-text { color: #5C8A5C; }
	.pet-eat-row {
		display: flex;
		align-items: baseline;
	}
	.eat-label {
		font-size: 30rpx;
		color: #8A7E68;
	}
	.eat-count {
		font-size: 40rpx;
		font-weight: 700;
		color: #E8A23D;
		margin: 0 10rpx;
	}
	.device-thumb {
		width: 130rpx;
		height: 100rpx;
		flex-shrink: 0;
	}
	.card-arrow {
		font-size: 44rpx;
		color: #C4B9A4;
		margin-left: 8rpx;
		font-weight: 300;
	}

	/* 四宫格 */
	.stat-grid {
		display: flex;
		gap: 16rpx;
		margin-bottom: 40rpx;
	}
	.stat-item {
		flex: 1;
		background: #FBF8F2;
		border-radius: 24rpx;
		padding: 24rpx 16rpx;
		display: flex;
		flex-direction: column;
		align-items: center;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.06);
	}
	.stat-icon {
		font-size: 36rpx;
		margin-bottom: 12rpx;
	}
	.stat-text {
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.stat-label {
		font-size: 22rpx;
		color: #A99C84;
		margin-bottom: 6rpx;
	}
	.stat-value {
		font-size: 24rpx;
		font-weight: 600;
		color: #4A4339;
		text-align: center;
	}
	.stat-value.good { color: #6FA86F; }

	/* 区块标题 */
	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24rpx;
	}
	.section-title {
		font-size: 36rpx;
		font-weight: 700;
		color: #2B2620;
	}
	.section-more {
		display: flex;
		align-items: center;
	}
	.more-text {
		font-size: 26rpx;
		color: #A99C84;
	}
	.more-arrow {
		font-size: 30rpx;
		color: #A99C84;
		margin-left: 6rpx;
	}

	/* 精选大卡 */
	.featured-card {
		position: relative;
		border-radius: 28rpx;
		overflow: hidden;
		margin-bottom: 40rpx;
		box-shadow: 0 8rpx 28rpx rgba(140, 120, 90, 0.12);
	}
	.featured-img {
		width: 100%;
		height: 440rpx;
		display: block;
		background: #EDE6D8;
	}
	.featured-play {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 96rpx;
		height: 96rpx;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.92);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 4rpx 16rpx rgba(0,0,0,0.15);
	}
	.play-icon {
		font-size: 36rpx;
		color: #2B2620;
		margin-left: 6rpx;
	}
	.featured-duration {
		position: absolute;
		left: 24rpx;
		bottom: 24rpx;
		background: rgba(43, 38, 32, 0.6);
		border-radius: 20rpx;
		padding: 6rpx 20rpx;
	}
	.duration-text {
		font-size: 24rpx;
		color: #fff;
	}

	/* 实时画面入口 */
	.live-entry {
		background: #FBF8F2;
		border-radius: 28rpx;
		padding: 28rpx 32rpx;
		display: flex;
		align-items: center;
		margin-bottom: 40rpx;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.06);
	}
	.live-left { flex: 1; }
	.live-title-row {
		display: flex;
		align-items: center;
		margin-bottom: 12rpx;
	}
	.live-title {
		font-size: 34rpx;
		font-weight: 700;
		color: #2B2620;
		margin-right: 16rpx;
	}
	.live-desc {
		font-size: 26rpx;
		color: #A99C84;
	}
	.live-right {
		position: relative;
		margin: 0 16rpx;
	}
	.live-thumb {
		width: 180rpx;
		height: 110rpx;
		border-radius: 16rpx;
		background: #EDE6D8;
	}
	.live-badge {
		position: absolute;
		right: 12rpx;
		bottom: 12rpx;
		width: 44rpx;
		height: 44rpx;
		border-radius: 50%;
		background: rgba(43, 38, 32, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.live-badge-icon { font-size: 24rpx; }

	/* 时间线 */
	.timeline-card {
		background: #FBF8F2;
		border-radius: 28rpx;
		padding: 8rpx 32rpx;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.06);
	}
	.timeline-item {
		display: flex;
		align-items: center;
		padding: 28rpx 0;
		border-bottom: 2rpx solid #F0EADD;
	}
	.timeline-item:last-child { border-bottom: none; }
	.timeline-check {
		width: 44rpx;
		height: 44rpx;
		border-radius: 50%;
		background: #6FA86F;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.check-icon {
		font-size: 26rpx;
		color: #fff;
		font-weight: 700;
	}
	.meal-thumb {
		width: 56rpx;
		height: 56rpx;
		border-radius: 50%;
		background: #EDE6D8;
		margin: 0 20rpx 0 24rpx;
		flex-shrink: 0;
	}
	.meal-time {
		font-size: 32rpx;
		font-weight: 700;
		color: #2B2620;
		margin-right: 24rpx;
	}
	.meal-name {
		flex: 1;
		font-size: 28rpx;
		color: #8A7E68;
	}
	.meal-action {
		display: flex;
		align-items: center;
	}
	.meal-action-text {
		font-size: 26rpx;
		color: #A99C84;
	}
	.meal-arrow {
		font-size: 30rpx;
		color: #C4B9A4;
		margin-left: 8rpx;
	}

	.bottom-safe { height: 40rpx; }
</style>
