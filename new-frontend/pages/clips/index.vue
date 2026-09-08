<template>
	<view class="clips-page">
		<!-- 顶部标题栏 -->
		<view class="page-header">
			<text class="page-title">片段</text>
			<view class="filter-btn" @click="goReplay">
				<text class="filter-text">录像回放</text>
			</view>
		</view>

		<!-- 日期切换 -->
		<scroll-view class="date-scroll" scroll-x show-scrollbar="false">
			<view class="date-track">
				<view class="date-chip" v-for="(d, idx) in dateChips" :key="idx"
					:class="{active: activeDate === idx}" @click="selectDate(idx)">
					<text class="chip-day">{{d.day}}</text>
					<text class="chip-label">{{d.label}}</text>
				</view>
			</view>
		</scroll-view>

		<!-- 精选横幅 -->
		<view class="hero-clip" @click="playClip(clips[0])" v-if="clips.length > 0">
			<image class="hero-img" :src="clips[0].cover" mode="aspectFill" />
			<view class="hero-overlay">
				<view class="hero-play">
					<text class="hero-play-icon">▶</text>
				</view>
			</view>
			<view class="hero-info">
				<text class="hero-tag">每日精选</text>
				<text class="hero-title">{{clips[0].title}}</text>
				<text class="hero-meta">{{clips[0].time}} · {{clips[0].duration}}秒</text>
			</view>
		</view>

		<!-- 片段网格 -->
		<view class="section-label">
			<text class="label-text">全部片段</text>
			<text class="label-count">{{clips.length}} 条</text>
		</view>

		<view class="clip-grid">
			<view class="clip-cell" v-for="(clip, idx) in clips" :key="idx" @click="playClip(clip)">
				<view class="cell-cover">
					<image class="cell-img" :src="clip.cover" mode="aspectFill" />
					<view class="cell-play">
						<text class="cell-play-icon">▶</text>
					</view>
					<view class="cell-duration">
						<text class="cell-duration-text">{{clip.duration}}″</text>
					</view>
				</view>
				<view class="cell-info">
					<text class="cell-title">{{clip.title}}</text>
					<text class="cell-time">{{clip.time}}</text>
				</view>
			</view>
		</view>

		<!-- 空状态 -->
		<view class="empty-clips" v-if="clips.length === 0">
			<text class="empty-emoji">🎬</text>
			<text class="empty-title">还没有片段</text>
			<text class="empty-desc">设备会自动剪辑{{petName}}的精彩时刻</text>
		</view>

		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	export default {
		data() {
			return {
				petName: '奶油',
				activeDate: 0,
				dateChips: [
					{ day: '今天', label: '6/17' },
					{ day: '昨天', label: '6/16' },
					{ day: '周日', label: '6/15' },
					{ day: '周六', label: '6/14' },
					{ day: '周五', label: '6/13' }
				],
				// 假数据片段，后续接 AI 自动剪辑
				clips: [
					{ title: '专注吃饭的奶油', time: '18:27', duration: 24, cover: '/static/images/clip-1.png' },
					{ title: '碗边踱步', time: '15:10', duration: 12, cover: '/static/images/clip-2.png' },
					{ title: '午后小憩', time: '13:45', duration: 31, cover: '/static/images/clip-3.png' },
					{ title: '美味的一餐', time: '12:43', duration: 18, cover: '/static/images/clip-4.png' },
					{ title: '好奇张望', time: '09:20', duration: 9, cover: '/static/images/clip-5.png' },
					{ title: '活力的一餐', time: '07:58', duration: 22, cover: '/static/images/clip-6.png' }
				],
				device: { sn: '', token: '' }
			}
		},
		onShow() {
			this.loadDevice()
		},
		methods: {
			loadDevice() {
				this.JLWXSDK.getDeviceList({ page: 1, limit: 1 }, (result) => {
					if (result.code === 2000 && result.data && result.data.deviceList && result.data.deviceList.length > 0) {
						const dev = result.data.deviceList[0]
						this.device.sn = dev.sn
						if (dev.nickname) this.petName = dev.nickname
						this.JLWXSDK.getDeviceToken({ sns: [dev.sn] }, (tokenRes) => {
							if (tokenRes.code === 2000 && tokenRes.data && tokenRes.data.length > 0) {
								this.device.token = tokenRes.data[0].token
							}
						})
					}
				})
			},
			selectDate(idx) {
				this.activeDate = idx
				// 后续：根据日期切换真实片段
			},
			playClip(clip) {
				uni.showToast({ title: clip.title + ' · ' + clip.duration + '秒', icon: 'none' })
				// 后续：播放真实片段视频
			},
			// 进入真实 SD 卡回放（接现有 replay 页）
			goReplay() {
				if (!this.device.sn) {
					uni.showToast({ title: '请先添加设备', icon: 'none' })
					return
				}
				uni.navigateTo({
					url: '/pages/live/replay?device=' + encodeURIComponent(JSON.stringify(this.device))
				})
			}
		}
	}
</script>

<style>
	.clips-page {
		min-height: 100vh;
		background: #F2EDE4;
		padding: 0 32rpx;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 40rpx 0 28rpx;
	}
	.page-title {
		font-size: 56rpx;
		font-weight: 700;
		color: #2B2620;
		letter-spacing: 4rpx;
	}
	.filter-btn {
		background: #FBF8F2;
		border-radius: 28rpx;
		padding: 14rpx 28rpx;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.08);
	}
	.filter-text {
		font-size: 26rpx;
		color: #8A7E68;
		font-weight: 600;
	}

	/* 日期切换 */
	.date-scroll {
		white-space: nowrap;
		margin-bottom: 32rpx;
	}
	.date-track {
		display: inline-flex;
		gap: 16rpx;
		padding: 4rpx 0;
	}
	.date-chip {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		background: #FBF8F2;
		border-radius: 20rpx;
		padding: 16rpx 28rpx;
		box-shadow: 0 4rpx 12rpx rgba(140, 120, 90, 0.05);
	}
	.date-chip.active {
		background: #2B2620;
	}
	.chip-day {
		font-size: 28rpx;
		font-weight: 600;
		color: #4A4339;
		margin-bottom: 4rpx;
	}
	.date-chip.active .chip-day { color: #fff; }
	.chip-label {
		font-size: 22rpx;
		color: #A99C84;
	}
	.date-chip.active .chip-label { color: #C4B9A4; }

	/* 精选横幅 */
	.hero-clip {
		position: relative;
		border-radius: 28rpx;
		overflow: hidden;
		margin-bottom: 40rpx;
		box-shadow: 0 8rpx 28rpx rgba(140, 120, 90, 0.12);
	}
	.hero-img {
		width: 100%;
		height: 400rpx;
		display: block;
		background: #EDE6D8;
	}
	.hero-overlay {
		position: absolute;
		top: 0; left: 0; right: 0; bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.hero-play {
		width: 96rpx;
		height: 96rpx;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.92);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 4rpx 16rpx rgba(0,0,0,0.15);
	}
	.hero-play-icon {
		font-size: 36rpx;
		color: #2B2620;
		margin-left: 6rpx;
	}
	.hero-info {
		position: absolute;
		left: 28rpx;
		bottom: 28rpx;
	}
	.hero-tag {
		display: inline-block;
		background: #E8A23D;
		color: #fff;
		font-size: 22rpx;
		padding: 4rpx 18rpx;
		border-radius: 16rpx;
		margin-bottom: 12rpx;
	}
	.hero-title {
		display: block;
		font-size: 36rpx;
		font-weight: 700;
		color: #fff;
		margin-bottom: 6rpx;
		text-shadow: 0 2rpx 8rpx rgba(0,0,0,0.3);
	}
	.hero-meta {
		font-size: 24rpx;
		color: rgba(255,255,255,0.85);
		text-shadow: 0 2rpx 8rpx rgba(0,0,0,0.3);
	}

	/* 区块标签 */
	.section-label {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		margin-bottom: 24rpx;
	}
	.label-text {
		font-size: 36rpx;
		font-weight: 700;
		color: #2B2620;
	}
	.label-count {
		font-size: 26rpx;
		color: #A99C84;
	}

	/* 片段网格 */
	.clip-grid {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
	}
	.clip-cell {
		width: 48.5%;
		margin-bottom: 28rpx;
	}
	.cell-cover {
		position: relative;
		border-radius: 24rpx;
		overflow: hidden;
		box-shadow: 0 6rpx 20rpx rgba(140, 120, 90, 0.1);
	}
	.cell-img {
		width: 100%;
		height: 280rpx;
		display: block;
		background: #EDE6D8;
	}
	.cell-play {
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 64rpx;
		height: 64rpx;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.9);
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.cell-play-icon {
		font-size: 26rpx;
		color: #2B2620;
		margin-left: 4rpx;
	}
	.cell-duration {
		position: absolute;
		right: 14rpx;
		bottom: 14rpx;
		background: rgba(43, 38, 32, 0.6);
		border-radius: 14rpx;
		padding: 2rpx 14rpx;
	}
	.cell-duration-text {
		font-size: 22rpx;
		color: #fff;
	}
	.cell-info {
		padding: 16rpx 8rpx 0;
	}
	.cell-title {
		display: block;
		font-size: 28rpx;
		font-weight: 600;
		color: #4A4339;
		margin-bottom: 6rpx;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cell-time {
		font-size: 24rpx;
		color: #A99C84;
	}

	/* 空状态 */
	.empty-clips {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 120rpx 0;
	}
	.empty-emoji {
		font-size: 96rpx;
		margin-bottom: 24rpx;
	}
	.empty-title {
		font-size: 34rpx;
		font-weight: 700;
		color: #4A4339;
		margin-bottom: 12rpx;
	}
	.empty-desc {
		font-size: 28rpx;
		color: #A99C84;
	}

	.bottom-safe { height: 40rpx; }
</style>
