<template>
	<view class="replay-page">
		<bobbo-nav-bar :title="pageTitle" title-align="left" :back-handler="goBack" />

		<view class="date-bar" v-if="mode === 'records'">
			<view class="date-btn" @click="changeDate(-1)"><text>前一天</text></view>
			<picker mode="date" :value="selectedDate" @change="onDateChange">
				<view class="date-display"><text>{{selectedDate}}</text></view>
			</picker>
			<view class="date-btn" @click="changeDate(1)"><text>后一天</text></view>
		</view>

		<view class="video-area" v-if="streamUrl || playUrl || playbackEnded || playbackFailed">
			<live-player
				v-if="playbackType === 'relay'"
				id="replayLivePlayer"
				class="replay-video"
				:src="streamUrl"
				mode="live"
				autoplay
				object-fit="contain"
				@error="onLiveError"
				@statechange="onLiveStateChange" />
			<video
				v-if="playbackType === 'hls' && !playbackEnded && !playbackFailed"
				id="replayVideo"
				class="replay-video"
				:src="playUrl"
				controls
				autoplay
				object-fit="contain"
				direction="90"
				:show-fullscreen-btn="true"
				:show-progress="false"
				:show-play-btn="true"
				:show-center-play-btn="false"
				:enable-progress-gesture="false"
				@error="onVideoError"
				@play="onVideoPlay"
				@pause="onVideoPause"
				@waiting="onVideoWaiting"
				@timeupdate="onVideoTimeUpdate"
				@fullscreenchange="onVideoFullscreenChange"
				@ended="onVideoEnded">
				<cover-view class="seek-loading-overlay" v-if="hlsSeeking">
					<cover-view class="seek-loading-plate">
						<cover-view class="seek-loading-rotor" :style="seekSpinnerStyle">
							<cover-image class="seek-loading-spinner" src="/static/images/replay-loading-spinner.png"></cover-image>
						</cover-view>
					</cover-view>
				</cover-view>
				<cover-view class="fullscreen-progress-overlay" :class="{ 'is-visible': videoFullscreen && currentRecord }">
					<cover-view
						class="fullscreen-progress-row"
						@touchstart.stop="onFullscreenProgressTouchStart"
						@touchmove.stop="onFullscreenProgressTouchMove"
						@touchend.stop="onFullscreenProgressTouchEnd"
						@touchcancel.stop="onFullscreenProgressTouchEnd">
						<cover-view class="fullscreen-time">{{formatProgressTime(displayCurrentSec)}}</cover-view>
						<cover-view class="fullscreen-progress-track">
							<cover-view class="fullscreen-progress-rail"></cover-view>
							<cover-view class="fullscreen-marker-layer">
								<cover-view
									v-for="(segment, segmentIndex) in markerSegments"
									:key="segment.key"
									class="fullscreen-marker-segment"
									:class="'is-' + segment.target"
									:style="segment.style"></cover-view>
								<cover-view
									v-for="(marker, markerIndex) in markerArrows"
									:key="marker.key"
									class="fullscreen-marker-arrow"
									:class="'is-' + marker.target"
									:style="marker.style"
									@tap.stop="seekToMarker(markerIndex)">
									<cover-view class="fullscreen-marker-arrow-head"></cover-view>
								</cover-view>
							</cover-view>
							<cover-view class="fullscreen-progress-fill" :style="'width:' + progressPercent + '%'"></cover-view>
							<cover-view class="fullscreen-progress-thumb" :style="'left:' + progressPercent + '%'"></cover-view>
						</cover-view>
						<cover-view class="fullscreen-time fullscreen-time-end">{{formatProgressTime(playbackDurationSec)}}</cover-view>
					</cover-view>
				</cover-view>
				<cover-view class="fullscreen-speed-overlay" :class="{ 'is-visible': videoFullscreen && currentRecord }">
					<cover-view
						v-for="rate in playbackRates"
						:key="rate"
						class="fullscreen-speed-option"
						:class="{ 'is-active': playbackRate === rate }"
						@tap.stop="setPlaybackRate(rate)">{{formatPlaybackRate(rate)}}</cover-view>
				</cover-view>
			</video>
			<view class="replay-ended-screen" v-if="playbackEnded && currentRecord" @click="replayCurrentRecord">
				<view class="replay-ended-button">重播</view>
			</view>
			<view class="replay-ended-screen" v-if="playbackFailed && currentRecord" @click="retryCurrentRecord">
				<view class="replay-ended-button">重试</view>
			</view>

			<view class="progress-panel" v-if="currentRecord">
				<view class="time-row">
					<text class="time-text">{{formatProgressTime(displayCurrentSec)}}</text>
					<text class="time-text">{{formatProgressTime(playbackDurationSec)}}</text>
				</view>
				<view class="progress-shell">
					<view class="progress-marker-layer">
						<view
							v-for="(segment, segmentIndex) in markerSegments"
							:key="segment.key"
							class="progress-marker-segment"
							:class="'is-' + segment.target"
							:style="segment.style"></view>
						<view
							v-for="(marker, markerIndex) in markerArrows"
							:key="marker.key"
							class="progress-marker-arrow"
							:class="'is-' + marker.target"
							:style="marker.style"
							@tap.stop="seekToMarker(markerIndex)"
							@click.stop="seekToMarker(markerIndex)">
							<view class="progress-marker-arrow-head"></view>
						</view>
					</view>
					<slider
						class="progress-slider"
						min="0"
						:max="playbackDurationSec"
						:value="displayCurrentSec"
						activeColor="#2FA35C"
						backgroundColor="#C4C4C0"
						block-color="transparent"
						block-size="8"
						@changing="onProgressChanging"
						@change="onProgressChange" />
				</view>
			</view>
		</view>

		<view class="record-list" v-if="recordList.length > 0">
			<view class="record-card" v-for="(item, index) in recordList" :key="index" @click="playRecord(item, index)">
				<view class="record-info">
					<text class="record-name">{{item.title || item.BeginTime || item.beginTime}}</text>
					<text class="record-time">时长: {{displayDuration(item)}}</text>
					<view class="marker-row" v-if="item.markerChips && item.markerChips.length > 0">
						<view class="marker-chip" v-for="(marker, markerIndex) in item.markerChips" :key="markerIndex" @click.stop="playMarker(item, marker, index)">
							<text class="marker-chip-text">{{marker.markerLabel}}</text>
						</view>
					</view>
				</view>
				<view class="record-actions">
					<view v-if="item.analysisLabel" class="analysis-status-pill" :class="'is-' + item.analysisTone">
						<view class="analysis-status-dot"></view>
						<text class="analysis-status-label">{{item.analysisLabel}}</text>
					</view>
					<text class="record-play">▶</text>
				</view>
			</view>
		</view>

		<view class="empty-state" v-if="recordList.length === 0 && !loading">
			<text class="empty-text">当天暂无录像</text>
		</view>
		<view class="loading" v-if="loading"><text class="loading-text">加载中...</text></view>
		<view class="debug-info"><text class="debug-text">{{debugLog}}</text></view>
	</view>
</template>

<script>
	import bobboNavBar from '@/components/bobbo-nav-bar/bobbo-nav-bar.vue'
	const { formatDate } = require('@/utils/util.js')
	const { attachReplayMarkers, buildReplayMarkerRanges, markerOffsetSec } = require('@/utils/feedAnalysis.js')
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage } = require('@/utils/backendClient.js')
	const { formatDurationLabel } = require('@/utils/durationLabel.js')
	const { REPLAY_PLAYBACK_RATES, normalizeReplayPlaybackRate, formatReplayPlaybackRate } = require('@/utils/replayPlaybackRate.js')
	const REPLAY_MARKER_CONTEXT_SEC = 1

	function progressPercentFromOffset(offsetSec, durationSec) {
		const duration = Math.max(1, Number(durationSec) || 0)
		const percent = Math.max(0, Number(offsetSec) || 0) / duration * 100
		return Math.round(Math.max(0, Math.min(100, percent)) * 1000) / 1000
	}

	function clampDisplayOffsetSec(offsetSec, durationSec) {
		const offset = Math.max(0, Number(offsetSec) || 0)
		const duration = Number(durationSec)
		return Number.isFinite(duration) && duration > 0 ? Math.min(duration, offset) : offset
	}

	function markerDisplayOffsetSec(marker, durationSec) {
		const rawOffsetSec = markerOffsetSec(marker)
		const displayOffsetSec = /_leave$/.test(marker.markerType || '')
			? rawOffsetSec + REPLAY_MARKER_CONTEXT_SEC
			: rawOffsetSec - REPLAY_MARKER_CONTEXT_SEC
		return clampDisplayOffsetSec(displayOffsetSec, durationSec)
	}

	function markerDisplayPercent(marker, durationSec) {
		return progressPercentFromOffset(markerDisplayOffsetSec(marker, durationSec), durationSec)
	}

	function markerSegmentDisplay(segment, durationSec) {
		const rawStartSec = Math.max(0, Number(segment.startSec || 0))
		const rawEndSec = Math.max(rawStartSec, Number(segment.endSec || rawStartSec))
		const displayStartSec = clampDisplayOffsetSec(rawStartSec - REPLAY_MARKER_CONTEXT_SEC, durationSec)
		const displayEndSec = Math.max(displayStartSec, clampDisplayOffsetSec(rawEndSec + REPLAY_MARKER_CONTEXT_SEC, durationSec))
		const leftPercent = progressPercentFromOffset(displayStartSec, durationSec)
		const rightPercent = progressPercentFromOffset(displayEndSec, durationSec)
		return { displayStartSec, displayEndSec, leftPercent, rightPercent }
	}

	function markerSegmentStyle(segment, durationSec) {
		const display = markerSegmentDisplay(segment, durationSec)
		return 'left:' + display.leftPercent + '%;width:' + Math.max(0, display.rightPercent - display.leftPercent) + '%'
	}

	export default {
		components: { bobboNavBar },
		data() {
			return {
				device: {},
				recordList: [],
				playUrl: '',
				streamUrl: '',
				sessionId: '',
				manifestSessionId: '',
				playbackType: 'relay',
				selectedDate: '',
				loading: false,
				debugLog: '',
				mode: 'records',
				pageTitle: '录像回放',
				playlistIndex: 0,
				currentRecord: null,
				currentPlaybackParams: {},
				playbackDurationSec: 0,
				displayCurrentSec: 0,
				hlsBaseSec: 0,
				hlsPlaying: false,
				hlsSeeking: false,
				videoFullscreen: false,
				playbackRate: 1,
				playbackRates: REPLAY_PLAYBACK_RATES,
				progressDragging: false,
				progressBeforeDragSec: 0,
				progressTimer: null,
				seekSpinnerRotationDeg: 0,
				seekSpinnerTransition: false,
				seekSpinnerTimer: null,
				livePlayerUnavailable: false,
				hlsFallbackInFlight: false,
				hlsSeekRequestId: 0,
				playbackEnded: false,
				playbackFailed: false
			}
		},
		computed: {
			seekSpinnerStyle() {
				const transition = this.seekSpinnerTransition ? 'transform 900ms linear' : 'none'
				return 'transform:rotate(' + this.seekSpinnerRotationDeg + 'deg);transition:' + transition
			},
			progressPercent() {
				if (!this.playbackDurationSec) return 0
				const percent = (Number(this.displayCurrentSec) || 0) / this.playbackDurationSec * 100
				return Math.max(0, Math.min(100, percent))
			},
			currentMarkers() {
				return this.currentRecord && Array.isArray(this.currentRecord.markers) ? this.currentRecord.markers : []
			},
			markerSegments() {
				return buildReplayMarkerRanges(this.currentMarkers, this.playbackDurationSec).map((segment, index) => ({
					...segment,
					...markerSegmentDisplay(segment, this.playbackDurationSec),
					key: 'segment_' + index + '_' + Math.round(Number(segment.startSec || 0) * 1000),
					style: markerSegmentStyle(segment, this.playbackDurationSec)
				}))
			},
			markerArrows() {
				return this.markerSegments.flatMap((segment, index) => {
					const arrows = [{
						key: 'marker_' + index + '_start_' + Math.round(segment.displayStartSec * 1000),
						target: segment.target,
						seekSec: segment.displayStartSec,
						style: 'left:' + segment.leftPercent + '%'
					}]
					if (segment.displayEndSec > segment.displayStartSec) {
						arrows.push({
							key: 'marker_' + index + '_end_' + Math.round(segment.displayEndSec * 1000),
							target: segment.target,
							seekSec: segment.displayEndSec,
							style: 'left:' + segment.rightPercent + '%'
						})
					}
					return arrows
				})
			}
		},
		watch: {
			hlsSeeking(active) {
				if (active) this.startSeekSpinner()
				else this.stopSeekSpinner()
			}
		},
		onLoad(opt) {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.device = JSON.parse(decodeURIComponent(opt.device || '{}'))
			const now = new Date()
			this.selectedDate = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
			if (opt.playlist) {
				const playlist = JSON.parse(decodeURIComponent(opt.playlist))
				this.mode = 'playlist'
				this.pageTitle = playlist.title || '吃播合集'
				this.recordList = attachReplayMarkers(Array.isArray(playlist.clips) ? playlist.clips : [], [])
				if (this.recordList.length > 0) this.playRecord(this.recordList[0], 0)
				return
			}
			if (opt.clip) {
				const clip = JSON.parse(decodeURIComponent(opt.clip))
				this.mode = 'clip'
				this.pageTitle = clip.title || '精选片段'
				this.recordList = attachReplayMarkers([clip], clip.markers || [])
				this.playRecord(clip, 0)
				return
			}
			this.getRecordList()
		},
		onUnload() {
			this.closeReplaySession()
			this.stopProgressTicker()
			this.stopSeekSpinner()
		},
		methods: {
			startSeekSpinner() {
				this.stopSeekSpinner()
				this.seekSpinnerRotationDeg = 0
				this.$nextTick(() => {
					if (!this.hlsSeeking) return
					this.seekSpinnerTransition = true
					this.seekSpinnerRotationDeg = 360
					this.seekSpinnerTimer = setInterval(() => {
						this.seekSpinnerRotationDeg += 360
					}, 850)
				})
			},
			stopSeekSpinner() {
				if (this.seekSpinnerTimer) clearInterval(this.seekSpinnerTimer)
				this.seekSpinnerTimer = null
				this.seekSpinnerTransition = false
				this.seekSpinnerRotationDeg = 0
			},
			log(msg) {
				this.debugLog = msg
				console.log('[replay]', msg)
			},
			calcDuration(begin, end) {
				const b = new Date(String(begin || '').replace(' ', 'T'))
				const e = new Date(String(end || '').replace(' ', 'T'))
				const durationSec = Math.round((e - b) / 1000)
				return Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1
			},
			calcDurationSec(item) {
				const directDuration = Number(item.durationSec || item.duration || item.Duration || 0)
				if (directDuration > 0) return Math.max(1, Math.round(directDuration))
				return this.calcDuration(item.BeginTime || item.beginTime, item.EndTime || item.endTime)
			},
			displayDuration(item) {
				return formatDurationLabel(this.calcDurationSec(item))
			},
			formatProgressTime(sec) {
				const value = Math.max(0, Math.round(Number(sec) || 0))
				const minutes = Math.floor(value / 60)
				const seconds = value % 60
				return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
			},
			markerOffsetSec(marker) {
				return markerOffsetSec(marker)
			},
			goBack() {
				if (this.videoFullscreen) {
					this.exitReplayFullscreen()
					return
				}
				uni.navigateBack()
			},
			async changeDate(offset) {
				const d = new Date(this.selectedDate)
				d.setDate(d.getDate() + offset)
				this.selectedDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
				await this.resetPlayback()
				this.getRecordList()
			},
			async onDateChange(e) {
				this.selectedDate = e.detail.value
				await this.resetPlayback()
				this.getRecordList()
			},
			async loadReplayMarkers() {
				try {
					const res = await callBackend('/api/feed-analysis/markers', {
						query: {
							deviceSn: this.device.sn,
							date: this.selectedDate
						}
					})
					if (res && res.ok) this.recordList = attachReplayMarkers(this.recordList, res.markers || [], res.analysisStatus || [])
				} catch (error) {
					console.log('[replay] load feed analysis markers failed', error)
				}
			},
			async getRecordList() {
				this.loading = true
				this.recordList = []
				this.log('查询录像...')
				if (!this.device.sn) {
					this.loading = false
					this.log('缺少设备')
					return
				}
				const date = new Date(this.selectedDate)
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/recordings', {
						query: { beginTime: formatDate(date, true), endTime: formatDate(date, false, true), channel: 0 }
					})
					this.recordList = Array.isArray(result.recordings) ? result.recordings : []
					this.log('找到 ' + this.recordList.length + ' 条录像')
					this.loadReplayMarkers()
				} catch (error) {
					console.log('[replay] getRecordList failed', error)
					this.log(getBackendErrorMessage(error, '查询失败'))
				} finally {
					this.loading = false
				}
			},
			playMarker(item, marker, index) {
				const playbackItem = Object.assign({}, item, { playbackParams: marker.playbackParams || item.playbackParams || {} })
				this.playRecord(playbackItem, index)
			},
			seekToMarker(markerOrIndex) {
				const marker = typeof markerOrIndex === 'number' ? this.markerArrows[markerOrIndex] : markerOrIndex
				if (!marker) return
				this.seekToSec(Number(marker.seekSec))
			},
			async playRecord(item, index) {
				if (typeof index === 'number') this.playlistIndex = index
				await this.resetPlayback()
				this.currentRecord = item
				this.playbackEnded = false
				this.playbackFailed = false
				this.currentPlaybackParams = item.playbackParams || {}
				this.playbackDurationSec = this.calcDurationSec(item)
				this.displayCurrentSec = Number(this.currentPlaybackParams.targetSec || 0)
				this.log('创建 HLS 回放...')
				uni.showLoading({ title: '加载录像...' })
				try {
					await this.startHlsFallback(item, this.currentPlaybackParams)
				} catch (error) {
					console.log('[replay] hls playback failed', error)
				} finally {
					uni.hideLoading()
				}
			},
			createRelaySession(item, params) {
				return callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/replay-sessions', {
					method: 'POST',
					data: {
						channel: 0,
						stream: params.stream || 'Main',
						beginTime: params.startTime || item.BeginTime || item.beginTime,
						endTime: params.endTime || item.EndTime || item.endTime,
						fileName: params.fileName || item.FileName || item.fileName,
						durationSec: item.durationSec,
						lanHost: this.device.ip || this.device.devIp || this.device.ipAddress || '',
						targetSec: Number(params.targetSec || 0)
					}
				})
			},
			applyPlaybackResult(result) {
				this.sessionId = result.sessionId || ''
				this.playbackDurationSec = Number(result.durationSec || this.playbackDurationSec)
				this.displayCurrentSec = Number(result.currentSec || 0)
				if (result.playbackType === 'hls' || result.transport === 'official-hls' || result.transport === 'rtsp-hls-relay') {
					this.playbackType = 'hls'
					this.playUrl = result.playUrl || result.url || result.streamUrl || ''
					this.streamUrl = ''
					this.log(result.sessionId ? '兼容 HLS 回放已开始' : '厂商 HLS 直连已开始')
					return
				}
				this.playbackType = 'relay'
				this.streamUrl = result.streamUrl || ''
				this.playUrl = ''
				this.log(result.fallback ? '已降级为官方 FLV 回放' : '原生低延迟回放已开始')
			},
			async startHlsFallback(item, params = {}, options = {}) {
				if (this.hlsFallbackInFlight) return
				this.hlsFallbackInFlight = true
				this.stopProgressTicker()
				this.playbackEnded = false
				this.playbackFailed = false
				this.playbackType = 'hls'
				this.streamUrl = ''
				if (!options.keepCurrentVideo) this.playUrl = ''
				else this.pauseReplayVideo()
				this.log('获取厂商 HLS 直连地址...')
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/playback-url', {
						method: 'POST',
						data: {
							channel: 0,
							streamType: 0,
							mediaType: 'hls',
							protocol: 'hls',
							preferDirectHls: true,
							startTime: params.startTime || item.BeginTime || item.beginTime,
							endTime: params.endTime || item.EndTime || item.endTime,
							fileName: params.fileName || item.FileName || item.fileName,
							durationSec: item.durationSec,
							targetSec: Number(params.targetSec || 0)
						}
					})
					this.playbackType = 'hls'
					this.sessionId = result.sessionId || ''
					this.manifestSessionId = result.manifestSessionId || ''
					this.hlsBaseSec = Number(result.currentSec || params.targetSec || 0)
					this.hlsPlaying = false
					this.playbackFailed = false
					this.displayCurrentSec = this.hlsBaseSec
					const nextPlayUrl = result.playUrl || result.url || result.streamUrl || ''
					if (!nextPlayUrl) throw new Error('回放地址为空')
					this.playUrl = nextPlayUrl
					this.streamUrl = ''
					this.hlsSeeking = false
					this.$nextTick(() => this.playReplayVideo())
					if (this.playbackType === 'relay') this.startProgressTicker()
					this.log(this.playUrl ? (this.sessionId ? '兼容 HLS 地址获取成功' : '厂商 HLS 直连地址获取成功') : '回放地址为空')
				} catch (error) {
					const message = getBackendErrorMessage(error, '获取回放失败')
					this.stopProgressTicker()
					this.hlsPlaying = false
					this.hlsSeeking = false
					this.playbackEnded = false
					this.playbackFailed = true
					this.videoFullscreen = false
					this.playUrl = ''
					this.streamUrl = ''
					this.log(message)
					uni.showToast({ title: message, icon: 'none' })
				} finally {
					this.hlsSeeking = false
					this.hlsFallbackInFlight = false
				}
			},
			async onProgressChange(e) {
				const targetSec = Number(e.detail.value || 0)
				const rollbackSec = this.progressDragging ? this.progressBeforeDragSec : this.displayCurrentSec
				await this.seekToSec(targetSec, rollbackSec)
			},
			async seekToSec(targetSec, rollbackSec = this.displayCurrentSec) {
				const previousSec = Math.max(0, Math.min(this.playbackDurationSec, Number(rollbackSec) || 0))
				this.progressDragging = false
				this.playbackEnded = false
				this.playbackFailed = false
				this.displayCurrentSec = targetSec
				if (this.sessionId) {
					const requestId = ++this.hlsSeekRequestId
					const isHls = this.playbackType === 'hls'
					if (isHls) {
						this.currentPlaybackParams = Object.assign({}, this.currentPlaybackParams, { targetSec })
						this.stopProgressTicker()
						this.hlsPlaying = false
						this.hlsSeeking = true
						this.pauseReplayVideo()
					}
					try {
						const result = await callBackend('/api/replay-sessions/' + encodeURIComponent(this.sessionId) + '/seek', {
							method: 'POST',
							data: { targetSec }
						})
						if (requestId !== this.hlsSeekRequestId) return
						this.displayCurrentSec = Number(result.currentSec || targetSec)
						if (isHls) {
							const nextPlayUrl = result.playUrl || result.streamUrl || ''
							if (!nextPlayUrl) throw new Error('回放地址为空')
							this.hlsBaseSec = this.displayCurrentSec
							this.playUrl = ''
							await new Promise((resolve) => this.$nextTick(resolve))
							if (requestId !== this.hlsSeekRequestId) return
							this.playUrl = nextPlayUrl
							this.$nextTick(() => this.playReplayVideo())
						}
						this.progressBeforeDragSec = this.displayCurrentSec
						this.log('已跳转到 ' + this.formatProgressTime(this.displayCurrentSec))
					} catch (error) {
						if (requestId !== this.hlsSeekRequestId) return
						this.displayCurrentSec = previousSec
						this.progressBeforeDragSec = previousSec
						if (isHls) {
							this.currentPlaybackParams = Object.assign({}, this.currentPlaybackParams, { targetSec: previousSec })
							this.hlsSeeking = false
							this.$nextTick(() => this.playReplayVideo())
						}
						const message = getBackendErrorMessage(error, '拖动失败')
						this.log(message)
						uni.showToast({ title: message, icon: 'none' })
					} finally {
						if (requestId === this.hlsSeekRequestId && !isHls) this.hlsSeeking = false
					}
					return
				}
				if (this.playbackType === 'hls') {
					const ctx = uni.createVideoContext && uni.createVideoContext('replayVideo', this)
					if (ctx && ctx.seek) ctx.seek(Math.max(0, targetSec - this.hlsBaseSec))
				}
			},
			onProgressChanging(e) {
				if (!this.progressDragging) this.progressBeforeDragSec = this.displayCurrentSec
				this.progressDragging = true
				this.displayCurrentSec = Number(e.detail.value || 0)
			},
			startProgressTicker() {
				this.stopProgressTicker()
				this.progressTimer = setInterval(() => {
					if (this.progressDragging || !this.currentRecord) return
					if (this.playbackType === 'hls' && (!this.hlsPlaying || this.hlsSeeking || this.playbackEnded || this.playbackFailed)) return
					this.displayCurrentSec = Math.min(this.playbackDurationSec, this.displayCurrentSec + this.playbackRate)
					if (this.displayCurrentSec >= this.playbackDurationSec) {
						this.stopProgressTicker()
						this.onVideoEnded()
					}
				}, 1000)
			},
			stopProgressTicker() {
				if (!this.progressTimer) return
				clearInterval(this.progressTimer)
				this.progressTimer = null
			},
			async resetPlayback() {
				this.stopProgressTicker()
				await this.closeReplaySession()
				this.playUrl = ''
				this.streamUrl = ''
				this.currentRecord = null
				this.currentPlaybackParams = {}
				this.playbackDurationSec = 0
				this.displayCurrentSec = 0
				this.hlsBaseSec = 0
				this.hlsPlaying = false
				this.hlsSeeking = false
				this.videoFullscreen = false
				this.progressDragging = false
				this.progressBeforeDragSec = 0
				this.hlsFallbackInFlight = false
				this.hlsSeekRequestId += 1
				this.playbackEnded = false
				this.playbackFailed = false
				this.playbackType = 'relay'
			},
			async closeReplaySession() {
				const closingSessionIds = [...new Set([
					this.sessionId,
					this.manifestSessionId
				].filter(Boolean))]
				this.sessionId = ''
				this.manifestSessionId = ''
				for (const sessionId of closingSessionIds) {
					await this.closeReplaySessionById(sessionId)
				}
			},
			async closeReplaySessionById(sessionId) {
				if (!sessionId) return
				try {
					await callBackend('/api/replay-sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
				} catch (error) {
					console.log('[replay] close session failed', error)
				}
			},
			async onLiveError(e) {
				console.error('[replay] live-player error', e.detail)
				if (e && e.detail && Number(e.detail.errno) === 102) this.livePlayerUnavailable = true
				this.log('低延迟播放失败')
				await this.closeReplaySession()
				this.playbackType = 'hls'
				this.streamUrl = ''
				if (this.currentRecord) this.startHlsFallback(this.currentRecord, this.currentPlaybackParams)
			},
			onLiveStateChange(e) {
				console.log('[replay] live-player state', e.detail)
			},
			async onVideoError(e) {
				console.error('[replay] video error', e.detail)
				this.hlsPlaying = false
				this.hlsSeeking = false
				this.stopProgressTicker()
				await this.closeReplaySession()
				this.playbackEnded = false
				this.playbackFailed = true
				this.videoFullscreen = false
				this.playUrl = ''
				this.streamUrl = ''
				this.log('视频播放失败')
			},
			onVideoFullscreenChange(e) {
				this.videoFullscreen = !!(e && e.detail && e.detail.fullScreen)
				if (this.videoFullscreen) this.$nextTick(() => this.applyPlaybackRate())
			},
			onVideoPlay() {
				this.hlsPlaying = true
				this.hlsSeeking = false
				this.playbackEnded = false
				this.playbackFailed = false
				this.applyPlaybackRate()
				this.startProgressTicker()
				this.log('HLS 回放播放中')
			},
			onVideoPause() {
				this.hlsPlaying = false
				this.stopProgressTicker()
				this.log('HLS 回放已暂停')
			},
			onVideoWaiting() {
				// WeChat HLS can keep rendering frames while still reporting waiting.
				this.log('HLS 回放缓冲中...')
			},
			onVideoTimeUpdate(e) {
				if (this.hlsSeeking) return
				if (this.progressDragging) return
				this.hlsPlaying = true
				if (!this.progressTimer) this.startProgressTicker()
				const currentTime = Number(e && e.detail && e.detail.currentTime) || 0
				const duration = Number(e && e.detail && e.detail.duration) || 0
				if (e && e.detail && Number(e.detail.duration) > 0) {
					this.playbackDurationSec = Math.max(this.playbackDurationSec, this.hlsBaseSec + duration)
				}
				if (currentTime > 0) {
					this.displayCurrentSec = Math.min(this.playbackDurationSec, this.hlsBaseSec + currentTime)
				}
				if (duration > 0 && currentTime >= duration - 0.25) this.onVideoEnded()
			},
			onVideoEnded() {
				this.hlsPlaying = false
				this.stopProgressTicker()
				this.displayCurrentSec = this.playbackDurationSec
				this.videoFullscreen = false
				this.playbackFailed = false
				if (this.mode === 'playlist') {
					const nextIndex = this.playlistIndex + 1
					if (nextIndex < this.recordList.length) {
						this.playRecord(this.recordList[nextIndex], nextIndex)
						return
					}
					this.playbackEnded = true
					this.playUrl = ''
					this.streamUrl = ''
					this.log('吃播播放完成')
					return
				}
				this.playbackEnded = true
				this.playUrl = ''
				this.streamUrl = ''
				this.log('回放播放完成')
			},
			async replayCurrentRecord() {
				if (!this.currentRecord) return
				const params = Object.assign({}, this.currentPlaybackParams, { targetSec: 0 })
				this.currentPlaybackParams = params
				this.displayCurrentSec = 0
				this.playbackEnded = false
				this.playbackFailed = false
				this.hlsPlaying = false
				this.hlsSeeking = false
				this.stopProgressTicker()
				uni.showLoading({ title: '重新播放...' })
				try {
					await this.closeReplaySession()
					await this.startHlsFallback(this.currentRecord, params)
				} finally {
					uni.hideLoading()
				}
			},
			async retryCurrentRecord() {
				if (!this.currentRecord) return
				const targetSec = Math.max(0, Math.min(this.playbackDurationSec, Number(this.displayCurrentSec || this.currentPlaybackParams.targetSec || 0)))
				const params = Object.assign({}, this.currentPlaybackParams, { targetSec })
				this.currentPlaybackParams = params
				this.playbackFailed = false
				this.playbackEnded = false
				this.hlsPlaying = false
				this.hlsSeeking = false
				this.stopProgressTicker()
				uni.showLoading({ title: '重新播放...' })
				try {
					await this.closeReplaySession()
					await this.startHlsFallback(this.currentRecord, params)
				} finally {
					uni.hideLoading()
				}
			},
			pauseReplayVideo() {
				try {
					uni.createVideoContext('replayVideo', this).pause()
				} catch (error) {
					console.log('[replay] pause video failed', error)
				}
			},
			playReplayVideo() {
				try {
					uni.createVideoContext('replayVideo', this).play()
				} catch (error) {
					console.log('[replay] play video failed', error)
				}
			},
			formatPlaybackRate(rate) {
				return formatReplayPlaybackRate(rate)
			},
			applyPlaybackRate() {
				try {
					const context = uni.createVideoContext && uni.createVideoContext('replayVideo', this)
					if (context && context.playbackRate) context.playbackRate(this.playbackRate)
				} catch (error) {
					console.log('[replay] apply playback rate failed', error)
				}
			},
			setPlaybackRate(rate) {
				this.playbackRate = normalizeReplayPlaybackRate(rate)
				this.applyPlaybackRate()
				this.log('回放速度 ' + formatReplayPlaybackRate(this.playbackRate))
			},
			exitReplayFullscreen() {
				try {
					uni.createVideoContext('replayVideo', this).exitFullScreen()
				} catch (error) {
					console.log('[replay] exit fullscreen failed', error)
				}
				this.videoFullscreen = false
			},
			onFullscreenProgressTouchStart(e) {
				if (!this.progressDragging) this.progressBeforeDragSec = this.displayCurrentSec
				this.progressDragging = true
				this.updateFullscreenProgressFromTouch(e)
			},
			onFullscreenProgressTouchMove(e) {
				this.updateFullscreenProgressFromTouch(e)
			},
			async onFullscreenProgressTouchEnd(e) {
				const targetSec = this.updateFullscreenProgressFromTouch(e)
				const rollbackSec = this.progressBeforeDragSec
				this.progressDragging = false
				if (targetSec !== null) await this.seekToSec(targetSec, rollbackSec)
			},
			updateFullscreenProgressFromTouch(e) {
				if (!this.playbackDurationSec) return null
				const touch = (e && e.touches && e.touches[0]) || (e && e.changedTouches && e.changedTouches[0])
				if (!touch) return null
				const info = uni.getSystemInfoSync ? uni.getSystemInfoSync() : {}
				const screenWidth = Math.max(Number(info.windowWidth || 0), Number(info.windowHeight || 0))
				const trackInset = 54
				const trackWidth = Math.max(1, screenWidth - trackInset * 2)
				const pageX = Number(touch.pageX || touch.clientX || touch.x || 0)
				const ratio = Math.max(0, Math.min(1, (pageX - trackInset) / trackWidth))
				const targetSec = Math.round(ratio * this.playbackDurationSec)
				this.displayCurrentSec = targetSec
				return targetSec
			}
		}
	}
</script>

<style lang="scss" scoped>
	.replay-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.date-bar { display: flex; align-items: center; justify-content: space-between; padding: 20rpx 32rpx; background: #FBFBFA; border-bottom: 2rpx solid #E8E8E5;
		.date-btn { height: 60rpx; padding: 0 24rpx; background: #F1F1EF; border-radius: 30rpx; display: flex; align-items: center;
			text { color: #141414; font-size: 25rpx; }
		}
		.date-display { padding: 12rpx 18rpx;
			text { color: #141414; font-size: 28rpx; font-weight: 600; }
		}
	}
	.video-area { position: sticky; top: 0; z-index: 10; width: 100%; background: #000000;
		.replay-video { width: 100%; height: 420rpx; }
	}
	.progress-panel { padding: 16rpx 24rpx 22rpx; background: #141414; border-top: 2rpx solid rgba(255,255,255,.12); }
	.time-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6rpx; }
	.time-text { color: #C4C4C0; font-size: 22rpx; }
	.progress-shell { position: relative; height: 48rpx; }
	.progress-slider { margin: 0; }
	.progress-marker-layer { position: absolute; left: 0; right: 0; top: 0; height: 48rpx; z-index: 3; pointer-events: none; }
	.progress-marker-segment { position: absolute; top: 19rpx; height: 4rpx; min-width: 4rpx; border-radius: 999rpx; background: rgba(47,163,92,.55); pointer-events: none; }
	.progress-marker-segment.is-feeding { top: 16rpx; height: 10rpx; background: rgba(232,115,74,.88); z-index: 2; }
	.progress-marker-arrow { position: absolute; top: -20rpx; width: 72rpx; height: 72rpx; margin-left: -36rpx; z-index: 8; pointer-events: auto; display: flex; justify-content: center; align-items: flex-start; }
	.progress-marker-arrow-head { width: 0; height: 0; margin-top: 4rpx; border-left: 16rpx solid transparent; border-right: 16rpx solid transparent; border-top: 28rpx solid #E8734A; }
	.progress-marker-arrow.is-cat .progress-marker-arrow-head { border-top-color: #2FA35C; }
	.progress-marker-arrow.is-feeding .progress-marker-arrow-head { border-top-color: #E8734A; }
	.fullscreen-progress-overlay { position: absolute; left: 0; right: 0; bottom: 2px; height: 1px; padding: 0 10px; opacity: 0; overflow: hidden; background: transparent; box-sizing: border-box; }
	.fullscreen-progress-overlay.is-visible { height: 22px; opacity: 1; overflow: visible; }
	.fullscreen-progress-row { display: flex; align-items: center; height: 22px; gap: 8px; }
	.fullscreen-time { min-width: 34px; color: rgba(255,255,255,.92); font-size: 10px; line-height: 14px; text-align: left; }
	.fullscreen-time-end { text-align: right; }
	.fullscreen-progress-track { position: relative; flex: 1; height: 12px; overflow: visible; }
	.fullscreen-progress-rail { position: absolute; left: 0; right: 0; top: 5px; height: 2px; border-radius: 999px; background: rgba(196,196,192,.48); }
	.fullscreen-marker-layer { position: absolute; left: 0; right: 0; top: 0; height: 12px; overflow: visible; z-index: 4; pointer-events: none; }
	.fullscreen-marker-segment { position: absolute; top: 5px; height: 2px; min-width: 2px; border-radius: 999px; background: rgba(47,163,92,.62); }
	.fullscreen-marker-segment.is-feeding { top: 4px; height: 4px; background: rgba(232,115,74,.9); z-index: 2; }
	.fullscreen-marker-arrow { position: absolute; top: -12px; width: 36px; height: 36px; margin-left: -18px; pointer-events: auto; display: flex; justify-content: center; align-items: flex-start; }
	.fullscreen-marker-arrow-head { width: 0; height: 0; margin-top: 2px; border-left: 9px solid transparent; border-right: 9px solid transparent; border-top: 15px solid #E8734A; }
	.fullscreen-marker-arrow.is-cat .fullscreen-marker-arrow-head { border-top-color: #2FA35C; }
	.fullscreen-marker-arrow.is-feeding .fullscreen-marker-arrow-head { border-top-color: #E8734A; }
	.fullscreen-progress-fill { position: absolute; left: 0; top: 5px; height: 2px; border-radius: 999px; background: #2FA35C; z-index: 1; }
	.fullscreen-progress-thumb { position: absolute; top: 4px; width: 3px; height: 3px; margin-left: -1.5px; border-radius: 999px; background: rgba(255,255,255,.72); z-index: 2; }
	.fullscreen-speed-overlay { position: absolute; top: 10px; right: 12px; z-index: 24; display: flex; align-items: center; gap: 5px; padding: 4px; border-radius: 999px; opacity: 0; pointer-events: none; background: rgba(20,20,20,.62); }
	.fullscreen-speed-overlay.is-visible { opacity: 1; pointer-events: auto; }
	.fullscreen-speed-option { min-width: 34px; height: 28px; padding: 0 6px; border-radius: 999px; color: rgba(255,255,255,.72); font-size: 11px; line-height: 28px; text-align: center; box-sizing: border-box; }
	.fullscreen-speed-option.is-active { color: #141414; font-weight: 700; background: #FFFFFF; }
	.seek-loading-overlay { position: absolute; left: 0; right: 0; top: 0; bottom: 0; z-index: 20; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.08); pointer-events: none; }
	.seek-loading-plate { width: 58px; height: 58px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(0,0,0,.58); }
	.seek-loading-rotor { width: 50px; height: 50px; }
	.seek-loading-spinner { display: block; width: 50px; height: 50px; }
	.replay-ended-screen { height: 420rpx; display: flex; align-items: center; justify-content: center; background: #000000; }
	.replay-ended-button { min-width: 136rpx; height: 64rpx; padding: 0 28rpx; border-radius: 32rpx; background: rgba(255,255,255,.14); color: #FFFFFF; font-size: 28rpx; font-weight: 600; line-height: 64rpx; text-align: center; border: 2rpx solid rgba(255,255,255,.22); }
	.record-list { padding: 20rpx 48rpx; }
	.record-card { display: flex; justify-content: space-between; align-items: center; min-height: 106rpx; background: #FBFBFA; padding: 20rpx 0; border-bottom: 2rpx solid #EFEFED;
		.record-info { flex: 1; min-width: 0; }
		.record-name { display: block; font-size: 28rpx; color: #141414; margin-bottom: 8rpx; font-weight: 500; }
		.record-time { display: block; font-size: 22rpx; color: #989893; }
		.marker-row { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 12rpx; }
		.marker-chip { padding: 6rpx 12rpx; border-radius: 20rpx; background: #F1F1EF; }
		.marker-chip-text { font-size: 20rpx; color: #141414; }
		.record-actions { display: flex; align-items: center; flex-shrink: 0; margin-left: 16rpx; }
		.analysis-status-pill { height: 44rpx; padding: 0 16rpx; border-radius: 22rpx; display: flex; align-items: center; gap: 8rpx; background: rgba(52,118,201,.10); color: #3476C9; }
		.analysis-status-pill.is-ready { background: rgba(47,163,92,.10); color: #2FA35C; }
		.analysis-status-pill.is-failed { background: rgba(232,115,74,.10); color: #E8734A; }
		.analysis-status-dot { width: 10rpx; height: 10rpx; border-radius: 50%; background: currentColor; }
		.analysis-status-label { color: inherit; font-size: 20rpx; font-weight: 600; white-space: nowrap; }
		.record-play { font-size: 34rpx; color: #141414; padding: 16rpx; }
	}
	.empty-state, .loading { text-align: center; padding: 80rpx 0; }
	.empty-text, .loading-text { color: #989893; font-size: 28rpx; }
	.debug-info { padding: 16rpx 48rpx; background: #F1F1EF; }
	.debug-text { font-size: 22rpx; color: #989893; word-break: break-all; }
</style>
