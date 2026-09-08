<template>
	<view class="today-detail-page">
		<bobbo-nav-bar :title="pageTitle" title-align="left" />

		<view class="detail-content">
			<view class="detail-score-summary">
				<view class="detail-score-main">
					<text class="detail-eyebrow">今日进食评分</text>
					<text class="detail-score">{{scoreDisplay}}</text>
				</view>
				<view class="detail-score-copy">
					<view class="detail-status"><view class="detail-status-dot"></view><text>{{statusLabel}}</text></view>
					<text class="detail-baseline">{{baselineCopy}}</text>
					<text class="detail-placeholder">{{placeholderLabel}}</text>
				</view>
			</view>

			<view class="detail-separator"></view>
			<view class="detail-metrics">
				<view class="detail-metric">
					<text class="detail-metric-label">频次</text>
					<text class="detail-metric-value">{{eatCount}} 次</text>
					<text class="detail-metric-note">身份识别占位</text>
				</view>
				<view class="detail-metric-divider"></view>
				<view class="detail-metric">
					<text class="detail-metric-label">总时长</text>
					<text class="detail-metric-value">{{eatMinutes}} 分钟</text>
					<text class="detail-metric-note">身份识别占位</text>
				</view>
				<view class="detail-metric-divider"></view>
				<view class="detail-metric">
					<text class="detail-metric-label">活性</text>
					<text class="detail-metric-value">{{activityLabel}}</text>
					<text class="detail-metric-note">展示占位</text>
				</view>
			</view>
			<view class="detail-separator"></view>

			<view class="reason-section">
				<text class="section-title">为什么是这个分数</text>
				<view class="reason-list">
					<view class="reason-item" v-for="reason in scoreReasons" :key="reason">
						<view class="reason-dot"></view>
						<text class="reason-copy">{{reason}}</text>
					</view>
				</view>
			</view>

			<view class="trend-section">
				<view class="trend-heading">
					<text class="section-title">进食趋势</text>
					<view class="period-control">
						<view class="period-option" :class="{ active: period === 14 }" @click="setPeriod(14)">近14天</view>
						<view class="period-option" :class="{ active: period === 30 }" @click="setPeriod(30)">近30天</view>
					</view>
				</view>

				<view class="metric-tabs">
					<view
						v-for="tab in metricTabs"
						:key="tab.key"
						class="metric-tab"
						:class="{ active: metric === tab.key }"
						@click="metric = tab.key"
					>{{tab.label}}</view>
				</view>

				<view class="trend-plot">
					<image class="trend-curve" src="/static/images/feeding-activity-curve.svg" mode="scaleToFill" />
					<view class="trend-demo-label">演示数据 · 趋势示意</view>
				</view>
				<view class="trend-axis"><text>{{rangeStartLabel}}</text><text>今天</text></view>
				<view class="trend-legend">
					<view class="legend-item"><view class="legend-dot legend-normal"></view><text>进食趋势</text></view>
					<view class="legend-item"><view class="legend-dot legend-anomaly"></view><text>异常示意</text></view>
				</view>
			</view>

			<view class="truthful-summary">
				<text class="summary-title">演示趋势</text>
				<text class="summary-copy">当前曲线为{{periodLabel}}演示数据，仅用于展示版式，不代表猫咪的真实历史变化。</text>
			</view>
		</view>
	</view>
</template>

<script>
	import bobboNavBar from '@/components/bobbo-nav-bar/bobbo-nav-bar.vue'

	export default {
		name: 'today-detail',
		components: { bobboNavBar },
		data() {
			return {
				catName: '猫咪',
				period: 14,
				metric: 'activity',
				snapshot: null,
				metricTabs: [
					{ key: 'activity', label: '活性' },
					{ key: 'frequency', label: '频次' },
					{ key: 'duration', label: '时长' }
				]
			}
		},
		computed: {
			pageTitle() {
				return `${this.catName || '猫咪'} · 进食数据`
			},
			health() {
				return this.snapshot && this.snapshot.health ? this.snapshot.health : {}
			},
			dashboard() {
				return this.snapshot && this.snapshot.dashboard ? this.snapshot.dashboard : {}
			},
			scoreDisplay() {
				return Number.isFinite(Number(this.health.score)) ? Number(this.health.score) : '—'
			},
			statusLabel() {
				return this.health.label || '基线建立中'
			},
			baselineCopy() {
				if (this.health.state === 'baseline_building') {
					return `已记录 ${Number(this.health.validDayCount) || 0}/${Number(this.health.requiredValidDays) || 7} 个有效日`
				}
				return '与近 14 个有效日的个人基线比较'
			},
			placeholderLabel() {
				return this.health.configVersion || 'ChewMeter 原型'
			},
			eatCount() {
				return Number(this.dashboard.todayEatCount) || 0
			},
			eatMinutes() {
				return Number(this.dashboard.eatMinutes) || 0
			},
			activityLabel() {
				return this.health.label || '基线建立中'
			},
			periodLabel() {
				return `近 ${this.period} 天`
			},
			rangeStartLabel() {
				return this.period === 14 ? '14天前' : '30天前'
			},
			scoreReasons() {
				if (this.health.state === 'baseline_building') {
					return [
						'进食活性只与这只猫自己的长期节律比较，不跨猫使用绝对分数。',
						`今日已记录 ${this.eatCount} 次进食，实际咀嚼与舔食 ${this.durationCopy}。`,
						'满 7 个有效记录日后建立首个基线，低置信度片段不会拉低活性。'
					]
				}
				return [
					'活性由进食节律速度 75% 与规律性 25% 组成，当前不使用行程指标。',
					`今日已记录 ${this.eatCount} 次进食，实际咀嚼与舔食 ${this.durationCopy}。`,
					'该分数用于观察相对个人基线的变化，不构成医疗诊断。'
				]
			},
			durationCopy() {
				const seconds = Number(this.dashboard.actualEatingSeconds) || 0
				if (seconds < 60) return `${Math.round(seconds)} 秒`
				return `${(seconds / 60).toFixed(seconds % 60 === 0 ? 0 : 1)} 分钟`
			}
		},
		onLoad(options = {}) {
			const stored = uni.getStorageSync('bobboTodayDetail')
			if (stored && typeof stored === 'object') this.snapshot = stored
			const storedName = stored && stored.cat && stored.cat.name
			const queryName = options.catName ? decodeURIComponent(options.catName) : ''
			this.catName = queryName || storedName || '猫咪'
		},
		methods: {
			setPeriod(days) {
				this.period = days === 30 ? 30 : 14
			}
		}
	}
</script>

<style>
	.today-detail-page { min-height: 100vh; box-sizing: border-box; background: #FBFBFA; color: #141414; }
	.detail-content { padding: 26rpx 32rpx 80rpx; }
	.detail-score-summary { min-height: 220rpx; padding: 20rpx 8rpx 34rpx; box-sizing: border-box; display: flex; align-items: flex-end; }
	.detail-score-main { flex: 0 0 45%; min-width: 0; }
	.detail-eyebrow { display: block; color: #989893; font-size: 23rpx; line-height: 32rpx; }
	.detail-score { display: block; margin-top: -4rpx; color: #141414; font-size: 174rpx; line-height: .9; font-weight: 400; }
	.detail-score-copy { flex: 1; min-width: 0; padding: 0 0 8rpx 18rpx; }
	.detail-status { display: flex; align-items: center; gap: 12rpx; color: #141414; font-size: 29rpx; line-height: 40rpx; font-weight: 650; }
	.detail-status-dot { flex-shrink: 0; width: 15rpx; height: 15rpx; border-radius: 50%; background: #2FA35C; }
	.detail-baseline { display: block; margin-top: 16rpx; color: #989893; font-size: 20rpx; line-height: 31rpx; }
	.detail-placeholder { display: inline-block; margin-top: 12rpx; padding: 5rpx 10rpx; border-radius: 6rpx; background: #F1F1EF; color: #989893; font-size: 18rpx; line-height: 24rpx; }
	.detail-separator { height: 2rpx; background: #E8E8E5; }
	.detail-metrics { min-height: 178rpx; padding: 28rpx 0; box-sizing: border-box; display: flex; align-items: stretch; }
	.detail-metric { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
	.detail-metric-divider { width: 2rpx; margin: 12rpx 0; background: #E8E8E5; }
	.detail-metric-label { color: #989893; font-size: 21rpx; line-height: 30rpx; }
	.detail-metric-value { margin-top: 7rpx; color: #141414; font-size: 31rpx; line-height: 42rpx; font-weight: 650; }
	.detail-metric-note { margin-top: 4rpx; color: #C4C4C0; font-size: 17rpx; line-height: 24rpx; }
	.reason-section { padding: 46rpx 6rpx 44rpx; }
	.section-title { color: #141414; font-size: 30rpx; line-height: 42rpx; font-weight: 650; }
	.reason-list { margin-top: 24rpx; }
	.reason-item { display: flex; align-items: flex-start; margin-top: 18rpx; }
	.reason-item:first-child { margin-top: 0; }
	.reason-dot { flex-shrink: 0; width: 9rpx; height: 9rpx; margin: 14rpx 18rpx 0 2rpx; border-radius: 50%; background: #141414; }
	.reason-copy { flex: 1; color: #989893; font-size: 22rpx; line-height: 36rpx; }
	.trend-section { padding: 40rpx 6rpx 26rpx; border-top: 2rpx solid #E8E8E5; }
	.trend-heading { display: flex; align-items: center; justify-content: space-between; gap: 20rpx; }
	.period-control { flex-shrink: 0; padding: 4rpx; border-radius: 28rpx; background: #F1F1EF; display: flex; }
	.period-option { min-width: 104rpx; height: 48rpx; padding: 0 14rpx; box-sizing: border-box; border-radius: 24rpx; color: #989893; font-size: 20rpx; line-height: 48rpx; text-align: center; }
	.period-option.active { background: #141414; color: #FFFFFF; }
	.metric-tabs { margin-top: 30rpx; display: flex; gap: 12rpx; }
	.metric-tab { min-width: 104rpx; height: 54rpx; padding: 0 20rpx; box-sizing: border-box; border-radius: 27rpx; background: #F1F1EF; color: #989893; font-size: 21rpx; line-height: 54rpx; text-align: center; }
	.metric-tab.active { background: #141414; color: #FFFFFF; }
	.trend-plot { position: relative; height: 220rpx; margin-top: 28rpx; overflow: hidden; }
	.trend-curve { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
	.trend-demo-label { position: absolute; top: 10rpx; right: 6rpx; padding: 5rpx 9rpx; border-radius: 6rpx; background: #F1F1EF; color: #989893; font-size: 17rpx; line-height: 23rpx; }
	.trend-axis { margin-top: 8rpx; display: flex; justify-content: space-between; color: #C4C4C0; font-size: 18rpx; }
	.trend-legend { margin-top: 22rpx; display: flex; gap: 30rpx; color: #989893; font-size: 19rpx; }
	.legend-item { display: flex; align-items: center; gap: 10rpx; }
	.legend-dot { width: 11rpx; height: 11rpx; border-radius: 50%; }
	.legend-normal { background: #2FA35C; }
	.legend-anomaly { background: #E8734A; }
	.truthful-summary { margin-top: 22rpx; padding: 28rpx 30rpx; border-radius: 18rpx; background: #F1F1EF; }
	.summary-title { display: block; color: #141414; font-size: 25rpx; line-height: 34rpx; font-weight: 650; }
	.summary-copy { display: block; margin-top: 8rpx; color: #989893; font-size: 21rpx; line-height: 33rpx; }
</style>
