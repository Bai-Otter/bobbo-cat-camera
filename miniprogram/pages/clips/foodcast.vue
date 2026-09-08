<template>
	<view class="foodcast-page">
		<bobbo-nav-bar :title="scopeLabel" title-align="left" :back-handler="goBack"></bobbo-nav-bar>
		<view class="options-panel">
			<view class="options-heading">
				<text>{{dateTitle || date}}</text>
				<text>{{isWorking ? '生成中，设置已锁定' : '选择成片风格'}}</text>
			</view>
			<text class="option-label">剪辑方式</text>
			<view class="mode-switch" :class="{disabled: isWorking}">
				<view class="mode-option" :class="{active: mode === 'natural'}" @click="selectMode('natural')"><text>自然吃播</text></view>
				<view class="mode-option" :class="{active: mode === 'quick_cut'}" @click="selectMode('quick_cut')"><text>萌点快剪</text></view>
			</view>
			<text class="option-label">画面方式</text>
			<view class="frame-switch" :class="{disabled: isWorking}">
				<view class="frame-option" :class="{active: frameMode === 'source'}" @click="selectFrameMode('source')"><text>保留原画</text></view>
				<view class="frame-option" :class="{active: frameMode === 'center_crop'}" @click="selectFrameMode('center_crop')"><text>中心方形</text></view>
			</view>
			<text class="option-label">成片时长</text>
			<view class="duration-switch" :class="{disabled: isWorking}">
				<view
					v-for="duration in targetDurationOptions"
					:key="duration"
					class="duration-option"
					:class="{active: targetDurationSec === duration}"
					@click="selectTargetDuration(duration)"
				><text>{{duration}} 秒</text></view>
			</view>
		</view>

		<view v-if="job && job.status === 'ready' && job.media" class="ready-view">
			<view class="video-shell" :class="{square: frameMode === 'center_crop'}">
				<video
					class="foodcast-video"
					:src="job.media.url"
					controls
					show-center-play-btn
					object-fit="contain"
					@error="onVideoError"
				/>
				<view class="ready-badge"><text>已生成 · {{durationLabel}}</text></view>
			</view>

			<view class="media-band">
				<view class="media-heading">
					<text class="media-title">{{dateTitle}}吃播</text>
				</view>
				<view class="music-line">
					<text class="music-mark">♪</text>
					<view class="music-copy">
						<text class="music-title">{{bgmTitle}}</text>
						<text class="music-artist" v-if="job.bgm && job.bgm.artist">{{job.bgm.artist}}</text>
					</view>
				</view>
			</view>

			<view class="action-bar">
				<button class="secondary-action" :disabled="creating || saving" @click="regenerate">重新生成</button>
				<button class="primary-action" :loading="saving" :disabled="creating" @click="saveVideo">保存到相册</button>
			</view>
		</view>

		<view v-else class="status-view">
			<view class="status-symbol" :class="statusClass">
				<text v-if="isWorking">{{progress}}%</text>
				<text v-else>!</text>
			</view>
			<text class="status-title">{{statusTitle}}</text>
			<text class="status-desc">{{statusDescription}}</text>

			<view class="progress-track" v-if="isWorking">
				<view class="progress-fill" :style="{width: progress + '%'}"></view>
			</view>
			<text class="background-note" v-if="isWorking">可以先返回日记，后台会继续生成</text>

			<view class="status-actions" v-if="job && (job.status === 'failed' || job.status === 'expired')">
				<button class="primary-action full" :loading="creating" @click="regenerate">重新生成</button>
			</view>
			<view class="status-actions" v-else-if="loadError && !job">
				<button class="primary-action full" :loading="creating" @click="restoreOrCreate">重试</button>
			</view>
		</view>
		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	const { callBackend } = require('@/utils/backendClient.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { foodcastErrorMessage, foodcastStageText, saveFoodcastVideo } = require('@/utils/foodcast.js')

	export default {
		data() {
			return {
				deviceSn: '',
				date: '',
				scope: 'day',
				mealId: '',
				mode: 'quick_cut',
				frameMode: 'source',
				targetDurationSec: 60,
				targetDurationOptions: [20, 30, 60],
				job: null,
				pollTimer: null,
				creating: false,
				saving: false,
				initialized: false,
				loadError: '',
				videoError: false
			}
		},
		computed: {
			requestData() {
				return { deviceSn: this.deviceSn, date: this.date, scope: this.scope, mealId: this.mealId, mode: this.mode, frameMode: this.frameMode, targetDurationSec: this.targetDurationSec }
			},
			scopeLabel() {
				return this.scope === 'meal' ? '单次进食吃播' : '今日吃播'
			},
			dateTitle() {
				const parts = String(this.date || '').split('-')
				return parts.length === 3 ? Number(parts[1]) + ' 月 ' + Number(parts[2]) + ' 日' : ''
			},
			progress() {
				return Math.max(0, Math.min(100, Number(this.job && this.job.progress) || 0))
			},
			isWorking() {
				return this.creating || Boolean(this.job && (this.job.status === 'queued' || this.job.status === 'running'))
			},
			statusTitle() {
				if (!this.job && this.loadError) return '暂时无法生成'
				return foodcastStageText(this.job || { status: 'queued' })
			},
			statusDescription() {
				if (this.job && (this.job.status === 'failed' || this.job.status === 'expired')) {
					return foodcastErrorMessage(this.job.errorCode || (this.job.status === 'expired' ? 'FOODCAST_EXPIRED' : ''))
				}
				if (this.loadError) return foodcastErrorMessage(this.loadError)
				if (this.job && this.job.stage === 'retrying') return '摄像头暂时繁忙，正在自动重试'
				return '正在精选进食画面，并随机搭配一首可爱音乐'
			},
			statusClass() {
				return this.isWorking ? 'working' : 'error'
			},
			durationLabel() {
				return Math.round(Number(this.job && this.job.media && this.job.media.durationSec) || 0) + ' 秒'
			},
			bgmTitle() {
				return this.job && this.job.bgm && this.job.bgm.title ? this.job.bgm.title : '随机授权音乐'
			}
		},
		onLoad(options) {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.deviceSn = decodeURIComponent(options.deviceSn || '')
			this.date = decodeURIComponent(options.date || '')
			this.scope = options.scope === 'meal' ? 'meal' : 'day'
			this.mealId = decodeURIComponent(options.mealId || '')
			this.mode = options.mode === 'natural' ? 'natural' : 'quick_cut'
			this.frameMode = options.frameMode === 'center_crop' ? 'center_crop' : 'source'
			const requestedDuration = Number(options.targetDurationSec)
			this.targetDurationSec = this.targetDurationOptions.includes(requestedDuration) ? requestedDuration : 60
			this.initialized = true
			this.restoreOrCreate()
		},
		onShow() {
			if (this.initialized && this.job && this.isWorking) this.startPolling()
		},
		onHide() {
			this.stopPolling()
		},
		onUnload() {
			this.stopPolling()
		},
		methods: {
			selectMode(mode) {
				const nextMode = mode === 'quick_cut' ? 'quick_cut' : 'natural'
				if (this.isWorking || nextMode === this.mode) return
				this.stopPolling()
				this.mode = nextMode
				this.job = null
				this.loadError = ''
				this.restoreOrCreate()
			},
			selectFrameMode(frameMode) {
				const nextFrameMode = frameMode === 'center_crop' ? 'center_crop' : 'source'
				if (this.isWorking || nextFrameMode === this.frameMode) return
				this.stopPolling()
				this.frameMode = nextFrameMode
				this.job = null
				this.loadError = ''
				this.restoreOrCreate()
			},
			selectTargetDuration(duration) {
				const nextDuration = Number(duration)
				if (this.isWorking || !this.targetDurationOptions.includes(nextDuration) || nextDuration === this.targetDurationSec) return
				this.stopPolling()
				this.targetDurationSec = nextDuration
				this.job = null
				this.loadError = ''
				this.restoreOrCreate()
			},
			async restoreOrCreate() {
				if (this.creating || !this.deviceSn || !this.date) return
				this.creating = true
				this.loadError = ''
				try {
					const latest = await callBackend('/api/foodcasts/latest', { query: this.requestData })
					if (latest.job && (latest.job.status === 'queued' || latest.job.status === 'running')) {
						this.applyJob(latest.job)
						return
					}
					await this.startGeneration()
				} catch (error) {
					this.loadError = String((error && error.message) || error || 'FOODCAST_FAILED')
				} finally {
					this.creating = false
				}
			},
			async startGeneration() {
				const result = await callBackend('/api/foodcasts', {
					method: 'POST',
					data: this.requestData
				})
				this.applyJob(result.job)
			},
			async loadJob() {
				if (!this.job || !this.job.id) return
				try {
					const result = await callBackend('/api/foodcasts/' + this.job.id)
					this.applyJob(result.job)
				} catch (error) {
					console.log('[foodcast] poll failed', error)
				}
			},
			applyJob(job) {
				this.job = job || null
				if (this.job && this.job.mode) this.mode = this.job.mode === 'quick_cut' ? 'quick_cut' : 'natural'
				if (this.job && this.job.frameMode) this.frameMode = this.job.frameMode === 'center_crop' ? 'center_crop' : 'source'
				if (this.job && this.targetDurationOptions.includes(Number(this.job.targetDurationSec))) this.targetDurationSec = Number(this.job.targetDurationSec)
				this.loadError = ''
				if (this.job && (this.job.status === 'queued' || this.job.status === 'running')) this.startPolling()
				else this.stopPolling()
			},
			startPolling() {
				this.stopPolling()
				this.pollTimer = setInterval(() => {
					this.loadJob()
				}, 2000)
			},
			stopPolling() {
				if (this.pollTimer) clearInterval(this.pollTimer)
				this.pollTimer = null
			},
			async regenerate() {
				if (this.creating) return
				this.creating = true
				this.loadError = ''
				this.videoError = false
				try {
					await this.startGeneration()
				} catch (error) {
					this.loadError = String((error && error.message) || error || 'FOODCAST_FAILED')
				} finally {
					this.creating = false
				}
			},
			async saveVideo() {
				if (this.saving || !this.job || !this.job.media) return
				this.saving = true
				try {
					await saveFoodcastVideo(uni, this.job.media.url)
					uni.showToast({ title: '已保存到相册', icon: 'success' })
				} catch (error) {
					if (String(error && error.message) !== 'ALBUM_PERMISSION_DENIED') {
						uni.showToast({ title: '保存失败，请重试', icon: 'none' })
					}
				} finally {
					this.saving = false
				}
			},
			onVideoError() {
				this.videoError = true
				uni.showToast({ title: '预览加载失败，可尝试保存到相册', icon: 'none' })
			},
			goBack() {
				uni.navigateBack()
			}
		}
	}
</script>

<style>
	.foodcast-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.options-panel { padding: 26rpx 32rpx 30rpx; border-bottom: 2rpx solid #E8E8E5; }
	.options-heading { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22rpx; }
	.options-heading text:first-child { font-size: 28rpx; line-height: 40rpx; font-weight: 650; color: #141414; }
	.options-heading text:last-child { font-size: 20rpx; line-height: 30rpx; color: #989893; }
	.option-label { display: block; margin: 16rpx 0 8rpx; font-size: 21rpx; line-height: 30rpx; font-weight: 600; color: #989893; }
	.mode-switch { height: 72rpx; display: flex; border: 2rpx solid #E8E8E5; box-sizing: border-box; }
	.mode-switch.disabled { opacity: 0.6; }
	.mode-option { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; }
	.mode-option + .mode-option { border-left: 2rpx solid #E8E8E5; }
	.mode-option.active { background: #141414; }
	.mode-option text { font-size: 24rpx; line-height: 34rpx; font-weight: 600; color: #989893; white-space: nowrap; }
	.mode-option.active text { color: #FFFFFF; }
	.frame-switch { height: 72rpx; display: flex; border: 2rpx solid #E8E8E5; box-sizing: border-box; }
	.frame-switch.disabled { opacity: 0.6; }
	.frame-option { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; }
	.frame-option + .frame-option { border-left: 2rpx solid #E8E8E5; }
	.frame-option.active { background: #141414; }
	.frame-option text { font-size: 24rpx; line-height: 34rpx; font-weight: 600; color: #989893; white-space: nowrap; }
	.frame-option.active text { color: #FFFFFF; }
	.duration-switch { height: 72rpx; display: flex; padding: 6rpx; background: #F1F1EF; }
	.duration-option { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; }
	.duration-option.active { background: #141414; }
	.duration-option text { font-size: 22rpx; line-height: 30rpx; font-weight: 600; color: #989893; white-space: nowrap; }
	.duration-option.active text { color: #FFFFFF; }
	.ready-view { padding-bottom: 188rpx; }
	.video-shell { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #141414; overflow: hidden; }
	.video-shell.square { aspect-ratio: 1 / 1; }
	.foodcast-video { width: 100%; height: 100%; display: block; }
	.ready-badge { position: absolute; top: 22rpx; left: 24rpx; height: 48rpx; padding: 0 18rpx; background: #141414; display: flex; align-items: center; }
	.ready-badge text { font-size: 22rpx; font-weight: 600; color: #FFFFFF; }
	.media-band { padding: 30rpx 32rpx 34rpx; background: #FBFBFA; border-bottom: 2rpx solid #E8E8E5; }
	.media-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 20rpx; }
	.media-title { font-size: 36rpx; line-height: 50rpx; font-weight: 700; color: #141414; }
	.music-line { min-height: 92rpx; margin-top: 26rpx; border-top: 2rpx solid #E8E8E5; padding-top: 22rpx; display: flex; align-items: center; }
	.music-mark { width: 52rpx; height: 52rpx; flex: 0 0 52rpx; border-radius: 50%; background: #141414; color: #FFFFFF; text-align: center; line-height: 52rpx; font-size: 28rpx; }
	.music-copy { min-width: 0; margin-left: 18rpx; }
	.music-title { display: block; font-size: 27rpx; line-height: 38rpx; font-weight: 600; color: #141414; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.music-artist { display: block; margin-top: 4rpx; font-size: 22rpx; line-height: 32rpx; color: #989893; }
	.action-bar { position: fixed; left: 0; right: 0; bottom: 0; min-height: 148rpx; padding: 22rpx 28rpx calc(22rpx + env(safe-area-inset-bottom)); background: #FBFBFA; border-top: 2rpx solid #E8E8E5; display: flex; gap: 18rpx; box-sizing: border-box; z-index: 20; }
	.secondary-action, .primary-action { flex: 1; height: 86rpx; margin: 0; border-radius: 0; font-size: 27rpx; font-weight: 650; line-height: 86rpx; }
	.secondary-action { color: #141414; background: #EFEFED; }
	.primary-action { color: #FFFFFF; background: #141414; }
	.secondary-action::after, .primary-action::after { border: none; }
	.primary-action.full { width: 100%; flex: none; }
	.status-view { min-height: calc(100vh - 470rpx); padding: 90rpx 54rpx 80rpx; display: flex; flex-direction: column; align-items: center; box-sizing: border-box; }
	.status-symbol { width: 160rpx; height: 160rpx; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 8rpx solid #E8E8E5; background: #FBFBFA; }
	.status-symbol.working { border-color: #141414 #E8E8E5 #E8E8E5 #141414; }
	.status-symbol.error { border-color: #E8734A; }
	.status-symbol text { font-size: 36rpx; line-height: 48rpx; font-weight: 700; color: #141414; }
	.status-title { margin-top: 44rpx; font-size: 36rpx; line-height: 50rpx; font-weight: 700; color: #141414; text-align: center; }
	.status-desc { max-width: 580rpx; margin-top: 16rpx; font-size: 26rpx; line-height: 42rpx; color: #989893; text-align: center; }
	.progress-track { width: 100%; max-width: 560rpx; height: 8rpx; margin-top: 44rpx; background: #E8E8E5; overflow: hidden; }
	.progress-fill { height: 100%; min-width: 6rpx; background: #141414; transition: width 0.25s ease; }
	.background-note { margin-top: 20rpx; font-size: 22rpx; line-height: 32rpx; color: #989893; }
	.status-actions { width: 100%; max-width: 560rpx; margin-top: 54rpx; }
	.bottom-safe { height: env(safe-area-inset-bottom); }
</style>
