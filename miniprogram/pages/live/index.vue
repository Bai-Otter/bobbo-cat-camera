<template>
	<view class="live-page" :class="{ 'has-replay-portrait-fullscreen': isReplayFullscreen }">
		<bobbo-nav-bar :title="device.nickname || '摄像头'" title-align="left" :back-handler="goBack" />

		<view class="video-area" :class="{ 'is-replay-portrait-fullscreen': isReplayFullscreen }">
			<video
				:key="viewerMode + ':' + inlineReplayKey + ':' + videoPlayerGeneration"
				:id="videoPlayerId"
				:data-player-generation="videoPlayerGeneration"
				class="video-player"
				:class="{ 'is-replay-portrait-video': isReplayFullscreen }"
				:src="liveUrl"
				autoplay
				:controls="!isAnyCustomFullscreen"
				:show-play-btn="!isAnyCustomFullscreen"
				:show-center-play-btn="!isAnyCustomFullscreen"
				:show-fullscreen-btn="viewerMode === 'live' && !isLandscapeFullscreen"
				:enable-progress-gesture="!isAnyCustomFullscreen"
				:muted="isMuted"
				object-fit="contain"
				@fullscreenchange="onFullscreenChange"
				@error="onVideoError"
				@play="onVideoPlay"
				@waiting="onVideoWaiting"
				@timeupdate="onVideoTimeUpdate"
				@ended="onVideoEnded"
			>
				<cover-view class="landscape-controls" v-show="isLandscapeFullscreen">
				<cover-view class="landscape-top-left">
					<cover-view class="landscape-round-button" @tap="exitLandscapeFullscreen">
						<cover-view class="icon-chevron"><cover-view class="icon-chevron-line"></cover-view></cover-view>
					</cover-view>
					<cover-view class="live-status-pill">
						<cover-view class="live-status-dot"></cover-view>
						<cover-view class="live-status-copy">{{ device.nickname || '餐厅喂食器' }}　直播中 · {{ liveElapsedText }}</cover-view>
					</cover-view>
				</cover-view>

				<cover-view class="landscape-top-right">
					<cover-view class="quality-pill" @tap="toggleQuality">{{ quality === '0' ? '高清' : '标清' }}</cover-view>
					<cover-view class="landscape-round-button more-button" @tap="showMoreSettings">•••</cover-view>
				</cover-view>

				<cover-view class="landscape-sound-control" @tap="toggleMute">
					<cover-view class="landscape-round-button">
						<cover-view class="sound-glyph">
							<cover-view class="sound-body"></cover-view>
							<cover-view class="sound-cone"></cover-view>
							<cover-view class="sound-wave sound-wave-inner" v-if="!isMuted"></cover-view>
							<cover-view class="sound-wave sound-wave-outer" v-if="!isMuted"></cover-view>
							<cover-view class="sound-slash" v-if="isMuted"></cover-view>
						</cover-view>
					</cover-view>
					<cover-view class="landscape-control-label">声音</cover-view>
				</cover-view>

				<cover-view class="landscape-center-controls">
					<cover-view v-if="canCapture" class="landscape-action" @tap="captureLiveImage">
						<cover-view class="landscape-round-button">
							<cover-view class="camera-glyph"><cover-view class="camera-lens"></cover-view></cover-view>
						</cover-view>
						<cover-view class="landscape-control-label">截图</cover-view>
					</cover-view>
					<cover-view v-if="canRecord" class="landscape-action" @tap="toggleLiveRecording">
						<cover-view
							class="record-button"
							:class="{ 'is-recording': mediaState.record === 'recording', 'is-pending': mediaState.record === 'starting' || mediaState.record === 'stopping' }"
						>
							<cover-view class="record-dot"></cover-view>
						</cover-view>
						<cover-view class="landscape-control-label">{{ recordingControlLabel }}</cover-view>
						<cover-view class="record-elapsed" v-if="mediaState.record === 'recording'">{{ recordingElapsedText }}</cover-view>
					</cover-view>
					<cover-view class="landscape-action" @tap="toggleTalkback">
						<cover-view class="landscape-round-button" :class="{ 'is-active': isTalkActive }">
							<cover-view class="mic-glyph">
								<cover-view class="mic-head"></cover-view>
								<cover-view class="mic-stem"></cover-view>
							</cover-view>
						</cover-view>
						<cover-view class="landscape-control-label">通话</cover-view>
					</cover-view>
				</cover-view>
				</cover-view>
			</video>
			<cover-view class="replay-fullscreen-tap-layer" v-show="isReplayFullscreen" @tap="toggleReplayControls"></cover-view>
			<cover-view class="replay-fullscreen-controls" v-show="isReplayFullscreen && replayControlsVisible">
				<cover-view class="landscape-top-left" :style="{ top: (replaySafeTopPx + 16) + 'px' }">
					<cover-view class="landscape-round-button" @tap.stop="exitReplayFullscreen">
						<cover-view class="icon-chevron"><cover-view class="icon-chevron-line"></cover-view></cover-view>
					</cover-view>
					<cover-view class="live-status-pill replay-status-pill">
						<cover-view class="replay-status-dot"></cover-view>
						<cover-view class="live-status-copy">{{ device.nickname || '摄像头' }}　录像回放</cover-view>
					</cover-view>
				</cover-view>
				<cover-view class="replay-speed-overlay" :style="{ top: (replaySafeTopPx + 72) + 'px' }">
					<cover-view
						v-for="rate in replayPlaybackRates"
						:key="rate"
						class="replay-speed-option"
						:class="{ 'is-active': replayPlaybackRate === rate }"
						@tap.stop="setReplayPlaybackRate(rate)"
					>{{ formatReplayRate(rate) }}</cover-view>
				</cover-view>
				<cover-view class="landscape-sound-control" :style="{ bottom: (replaySafeBottomPx + 82) + 'px' }" @tap.stop="toggleMute">
					<cover-view class="landscape-round-button">
						<cover-view class="sound-glyph">
							<cover-view class="sound-body"></cover-view>
							<cover-view class="sound-cone"></cover-view>
							<cover-view class="sound-wave sound-wave-inner" v-if="!isMuted"></cover-view>
							<cover-view class="sound-wave sound-wave-outer" v-if="!isMuted"></cover-view>
							<cover-view class="sound-slash" v-if="isMuted"></cover-view>
						</cover-view>
					</cover-view>
					<cover-view class="landscape-control-label">声音</cover-view>
				</cover-view>
				<cover-view class="landscape-center-controls replay-center-controls" :style="{ bottom: (replaySafeBottomPx + 80) + 'px' }">
					<cover-view v-if="canRecord" class="landscape-action" @tap.stop="toggleReplayClipRecording">
						<cover-view class="record-button" :class="{ 'is-recording': replayClipStartSec !== null, 'is-pending': replayClipExporting }">
							<cover-view class="record-dot"></cover-view>
						</cover-view>
						<cover-view class="landscape-control-label">{{ replayClipControlLabel }}</cover-view>
						<cover-view class="record-elapsed" v-if="replayClipStartSec !== null">{{ replayClipElapsedText }}</cover-view>
					</cover-view>
				</cover-view>
				<cover-view class="replay-progress-shell" :style="{ bottom: (replaySafeBottomPx + 20) + 'px' }">
					<cover-view class="replay-progress-time">{{formatReplayProgress(replayDisplaySec)}}</cover-view>
					<cover-view class="replay-progress-track" @touchstart.stop="onReplayProgressTouchStart" @touchmove.stop="onReplayProgressTouchMove" @touchend.stop="onReplayProgressTouchEnd" @touchcancel.stop="onReplayProgressTouchCancel">
						<cover-view class="replay-progress-fill" :style="{width: replayProgressPercent + '%'}"></cover-view>
						<cover-view v-for="(range, index) in selectedReplayMarkerRanges" :key="index" class="replay-marker-range" :class="'is-' + range.target" :style="{left: range.leftPercent + '%', width: Math.max(1, range.widthPercent) + '%'}"></cover-view>
						<cover-view class="replay-progress-thumb" :style="{left: replayProgressPercent + '%'}"></cover-view>
					</cover-view>
					<cover-view class="replay-progress-time">{{formatReplayProgress(replayDurationSec)}}</cover-view>
				</cover-view>
			</cover-view>
			<view class="video-mask" v-if="showVideoMask">
				<text class="mask-text">{{ statusText }}</text>
				<view class="mask-actions" v-if="playState === 'error'">
					<view class="retry-btn" @click="retryPlayback"><text class="retry-btn-text">重新连接</text></view>
				</view>
			</view>
		</view>
		<view class="replay-speed-bar" v-if="viewerMode === 'replay'">
			<text class="replay-speed-label">播放速度</text>
			<view class="replay-speed-options">
				<view
					v-for="rate in replayPlaybackRates"
					:key="rate"
					class="replay-speed-chip"
					:class="{ 'is-active': replayPlaybackRate === rate }"
					@click="setReplayPlaybackRate(rate)"
				>{{ formatReplayRate(rate) }}</view>
			</view>
			<view class="replay-fullscreen-entry" @click="enterReplayFullscreen"><text>全屏</text></view>
		</view>

		<view class="action-bar">
			<view class="action-btn" :class="{'is-active': contentPanel === 'alerts'}" @click="showAlertPanel">
				<text class="action-icon">警</text>
				<view class="action-copy"><text class="action-label">移动警报</text><text class="action-hint">{{motionAlarms.length ? motionAlarms.length + ' 条消息' : '查看消息'}}</text></view>
			</view>
			<view class="action-btn" :class="{'is-active': contentPanel === 'replay'}" @click="handleReplayAction">
				<text class="action-icon">回</text>
				<view class="action-copy"><text class="action-label">{{viewerMode === 'replay' ? '返回实时' : '回放'}}</text><text class="action-hint">{{viewerMode === 'replay' ? '继续看直播' : '查看录像'}}</text></view>
			</view>
		</view>

		<view class="alert-panel" v-if="contentPanel === 'alerts'">
			<view class="replay-header">
				<view><text class="replay-title">移动警报</text><text class="replay-subtitle">警报按时间倒序排列，设备侦测始终保持开启</text></view>
				<picker mode="date" :value="replayDate" @change="onAlertDateChange"><view class="date-pill"><text>{{replayDate}}</text></view></picker>
			</view>
			<view class="replay-loading" v-if="motionAlertsLoading && !motionAlarms.length"><text>正在读取警报...</text></view>
			<scroll-view class="alert-list" v-else-if="motionAlarms.length" scroll-y :show-scrollbar="false">
				<view class="alert-card" v-for="alarm in motionAlarms" :key="alarm.id">
					<image v-if="alarm.imageUrl" class="alert-image" :src="alarm.imageUrl" mode="aspectFill" show-menu-by-longpress />
					<view v-else class="alert-image alert-image-placeholder"><text>警</text></view>
					<view class="alert-copy"><text class="alert-title">{{alarm.label || '检测到移动'}}</text><text class="alert-time">{{formatAlarmTime(alarm.occurredAt)}}</text></view>
				</view>
			</scroll-view>
			<view class="replay-empty" v-else><text>当天还没有移动警报</text></view>
		</view>

		<view class="inline-replay" v-if="contentPanel === 'replay'">
			<view class="replay-header">
				<view>
					<text class="replay-title">录像回放</text>
					<text class="replay-subtitle">灰色为录像 · 绿色为有猫 · 橙色为进食</text>
				</view>
				<picker mode="date" :value="replayDate" @change="onInlineReplayDateChange">
					<view class="date-pill"><text>{{replayDate}}</text></view>
				</picker>
			</view>
			<view class="replay-loading" v-if="replayLoading"><text>正在读取录像...</text></view>
			<scroll-view class="inline-record-list" v-else-if="replayRecords.length" scroll-y :show-scrollbar="false">
				<view class="timeline-list-layout">
					<view class="day-timeline-band">
						<view v-for="(segment, segmentIndex) in replayDayTimelineSegments" :key="segmentIndex" class="day-timeline-segment" :class="'is-' + segment.target" :style="{ top: segment.topPercent + '%', height: segment.heightPercent + '%' }"></view>
					</view>
					<view class="timeline-record-row" v-for="item in replayRecords" :key="item.recordingKey">
						<view class="timeline-time-cell"><text class="timeline-time">{{formatInlineRecordTime(item)}}</text></view>
						<view class="inline-record-card" :class="{'is-selected': inlineReplayKey === item.recordingKey}" @click="playInlineRecord(item)">
					<image v-if="item.thumbnailUrl" class="record-cover" :src="item.thumbnailUrl" mode="aspectFill" />
					<view v-else class="record-cover record-cover-placeholder"><text>回</text></view>
					<view class="record-copy">
						<text class="record-title">{{formatInlineRecordTime(item)}}</text>
						<text class="record-meta">{{formatInlineDuration(item)}} · {{item.thumbnailState === 'pending' ? '封面生成中' : '摄像头录像'}}</text>
					</view>
					<text class="record-arrow">›</text>
						</view>
					</view>
				</view>
			</scroll-view>
			<view class="replay-empty" v-else><text>当天还没有录像</text></view>
		</view>
	</view>
</template>

<script>
	import bobboNavBar from '@/components/bobbo-nav-bar/bobbo-nav-bar.vue'
	const { ensureAppSession } = require('@/utils/appAuth.js')
	const { callBackend, getBackendErrorMessage, refreshBackendSession } = require('@/utils/backendClient.js')
	const { callDemoData } = require('@/utils/demoCloud.js')
	const { saveRemoteImage, saveRemoteVideo } = require('@/utils/mediaAlbum.js')
	const { buildDeviceCapturePayload, extractCoverCandidate, materializeCoverCandidate, persistDeviceCover, summarizeCaptureResult } = require('@/utils/deviceCoverSync.js')
	const { createLiveMediaControl } = require('@/utils/liveMediaControl.js')
	const { createPlaybackHealthTracker } = require('@/utils/livePlaybackHealth.js')
	const { createLivePlaybackDiagnostics, extractLivePlaybackErrorCode } = require('@/utils/livePlaybackDiagnostics.js')
	const { createMediaActionGuard } = require('@/utils/liveMediaActionGuard.js')
	const { createRecordingSaveLedger, formatElapsed, initialState, mediaActionAcknowledgements, reduceMediaState } = require('@/utils/liveMediaState.js')
	const { upsertOwnedDevice } = require('@/utils/ownedDeviceCache.js')
	const { markDevicePlaybackOnline } = require('@/utils/accessibleDeviceStatus.js')
	const { ensureSharedLiveAccess } = require('@/utils/sharedLiveAccess.js')
	const { buildRouteOrder, markHealthyRoute } = require('@/utils/liveRoutePreference.js')
	const { formatDate } = require('@/utils/util.js')
	const { formatDurationLabel } = require('@/utils/durationLabel.js')
	const { REPLAY_PLAYBACK_RATES, normalizeReplayPlaybackRate, formatReplayPlaybackRate } = require('@/utils/replayPlaybackRate.js')
	const { attachReplayMarkers, buildRecordingKey, buildReplayMarkerRanges } = require('@/utils/feedAnalysis.js')
	const { buildDayTimelineGeometry } = require('@/utils/replayTimeline.js')
	const { targetSecFromTrack } = require('@/utils/replaySeek.js')
	const {
		buildLivestreamPlan,
		buildTimeSyncPayload,
		extractDeviceTime,
		isTransientLivestreamFailure,
		shouldPromptTimeSync,
		shouldFallbackToSdkLive
	} = require('@/utils/deviceMediaState.js')

	const FIRST_FRAME_READY_DELAY_MS = 1200
	const COVER_CAPTURE_DELAY_MS = 12000
	const KEEPALIVE_INTERVAL_MS = 10000
	const LIVESTREAM_RETRY_DELAY_MS = 800
	const MEDIA_START_TIMEOUT_MS = 20000
	const MEDIA_STOP_TIMEOUT_MS = 12000
	const MEDIA_RECORD_FINALIZE_TIMEOUT_MS = 120000
	const MEDIA_TALK_CLOSE_TIMEOUT_MS = 30000
	const LIVE_PRIORITY_REFRESH_MS = 30000
	const LIVE_PRIORITY_HOLD_MS = 90000
	const PLAYBACK_HEALTH_INTERVAL_MS = 5000
	const PLAYBACK_STALL_THRESHOLD_MS = 3000
	const PLAYBACK_RECOVERY_STALL_MS = 8000
	const PLAYBACK_RECOVERY_COOLDOWN_MS = 12000
	const PLAYBACK_RECOVERY_MAX_ATTEMPTS = 1
	const REPLAY_STALL_RECOVERY_MS = 5000
	const REPLAY_RECOVERY_POLL_MS = 700
	const REPLAY_RECOVERY_MAX_ATTEMPTS = 3
	const delay = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))

	export default {
		components: { bobboNavBar },
		data() {
			return {
				device: {},
				liveUrl: '',
				quality: '0',
				keepAliveTimer: null,
				livePriorityTimer: null,
				playbackHealthTimer: null,
				firstFrameTimer: null,
				coverCaptureTimer: null,
				statusText: '准备中...',
				playState: 'idle',
				activeRequestId: 0,
				currentStreamPayload: null,
				timeSyncPromptShown: false,
				pendingReplayNavigation: false,
				resumePlaybackOnShow: false,
				resumePlaybackReason: '',
				leavingLivePage: false,
				sdkFallbackAttempted: false,
				sdkFallbackInProgress: false,
				mediaState: initialState(),
				videoContext: null,
				clockTimer: null,
				clockNow: Date.now(),
				liveStartedAt: 0,
				recordingHlsSessionId: '',
				recordingOwnsHlsSession: false,
				savingRecordingId: '',
				recordingRecoveryPending: false,
				recordingRecoveryTimer: null,
				lastVideoProgressAt: 0,
				stallRecoveryInProgress: false,
				stallRecoveryAttempts: 0,
				lastStallRecoveryAt: 0,
				coverCaptureAttempted: false,
				coverCaptureInFlight: false,
				snapshotInFlight: false,
				deviceLoginReady: false,
				deviceLoginToken: '',
				viewerMode: 'live',
				replayExpanded: false,
				contentPanel: 'alerts',
				replayDate: '',
				replayRecords: [],
				replayDayMarkers: [],
				replayDayMeals: [],
				timelineAnalysisStatus: [],
				timelineRevision: '',
				replayLoading: false,
				motionAlarms: [],
				motionAlarmRevision: '',
				motionAlertsLoading: false,
				motionAlarmImagePollTimer: null,
				motionAlarmRefreshTimer: null,
				timelineRefreshTimer: null,
				timelineLoading: false,
				pageVisible: true,
				motionAlertPreference: { enabled: true },
				inlineReplaySessionId: '',
				inlineReplayManifestSessionId: '',
				inlineReplayKey: '',
				inlineReplayRecord: null,
				replayBaseSec: 0,
				replayMediaTime: 0,
				replayLastProgressAt: 0,
				replayRecoveryAttempts: 0,
				replayRecoveryTimer: null,
				replayTransientErrorTimer: null,
				replayRecoveryInProgress: false,
				replayFullscreen: false,
				replayControlsVisible: true,
				replayControlsHideTimer: null,
				replaySafeTopPx: 56,
				replaySafeBottomPx: 20,
				replayProgressDragging: false,
				replayProgressBeforeDragSec: 0,
				replayProgressRect: { left: 0, width: 0 },
				replayPendingSeekSec: 0,
				replayProgressGestureId: 0,
				replayProgressCommittedGestureId: 0,
				replaySeekInProgress: false,
				replaySourceSwitching: false,
				replaySourceSwitchTimer: null,
				replaySeekRequestId: 0,
				replayDurationSec: 0,
				replayHasStarted: false,
				replayTransport: '',
				replayPlaybackRate: 1,
				replayPlaybackRates: REPLAY_PLAYBACK_RATES,
				replayClipStartSec: null,
				replayClipExporting: false,
				replayClipExportRecordingId: '',
				thumbnailPollTimer: null,
				videoPlayerGeneration: 0
			}
		},
		created() {
			// Native wx/uni objects contain Symbol keys. Keeping the controller outside
			// reactive data prevents Vue from traversing RecorderManager and SocketTask.
			Object.defineProperty(this, 'liveMediaControl', {
				configurable: true,
				writable: true,
				value: null
			})
			Object.defineProperty(this, 'liveMediaConnectPromise', {
				configurable: true,
				writable: true,
				value: null
			})
			Object.defineProperty(this, 'mediaActionVersions', {
				configurable: true,
				value: { record: 0, talk: 0 }
			})
			Object.defineProperty(this, 'playbackConnectPromise', {
				configurable: true,
				writable: true,
				value: null
			})
			Object.defineProperty(this, 'attemptedPlaybackRoutes', {
				configurable: true,
				writable: true,
				value: new Set()
			})
			Object.defineProperty(this, 'liveMediaActionGuard', {
				configurable: true,
				value: createMediaActionGuard({
					onTimeout: (event) => this.onLiveMediaActionTimeout(event)
				})
			})
			Object.defineProperty(this, 'recordingSaveLedger', {
				configurable: true,
				value: createRecordingSaveLedger()
			})
			Object.defineProperty(this, 'recordingPreparationPromise', {
				configurable: true,
				writable: true,
				value: null
			})
			Object.defineProperty(this, 'recordingPreparationGeneration', {
				configurable: true,
				writable: true,
				value: 0
			})
			Object.defineProperty(this, 'playbackHealthTracker', {
				configurable: true,
				value: createPlaybackHealthTracker({
					stallThresholdMs: PLAYBACK_STALL_THRESHOLD_MS
				})
			})
			Object.defineProperty(this, 'livePlaybackDiagnostics', {
				configurable: true,
				value: createLivePlaybackDiagnostics({ enabled: false })
			})
		},
		computed: {
			videoPlayerId() {
				return `live-video-${this.videoPlayerGeneration}`
			},
			canCapture() {
				return this.hasDevicePermission('snapshot')
			},
			canRecord() {
				return this.hasDevicePermission('record')
			},
			isLandscapeFullscreen() {
				return this.viewerMode === 'live' && !!this.mediaState.landscape
			},
			isReplayFullscreen() {
				return this.viewerMode === 'replay' && !!this.replayFullscreen
			},
			isAnyCustomFullscreen() {
				return this.isLandscapeFullscreen || this.isReplayFullscreen
			},
			replayDisplaySec() {
				if (this.replayProgressDragging) return this.replayPendingSeekSec
				return Math.max(0, Math.min(this.replayDurationSec, this.replayBaseSec + this.replayMediaTime))
			},
			replayProgressPercent() {
				if (!this.replayDurationSec) return 0
				return Math.max(0, Math.min(100, this.replayDisplaySec / this.replayDurationSec * 100))
			},
			selectedReplayMarkerRanges() {
				return buildReplayMarkerRanges((this.inlineReplayRecord && this.inlineReplayRecord.markers) || [], this.replayDurationSec)
			},
			replayDayTimelineSegments() {
				return buildDayTimelineGeometry(this.replayRecords, this.replayDayMarkers, this.replayDayMeals).segments
			},
			showVideoMask() {
				if (this.viewerMode === 'replay') {
					// A delayed HLS error can arrive after the player has already rendered
					// and resumed. Never let that stale state cover a visible replay.
					if (this.liveUrl && this.replayHasStarted) return false
					return !this.liveUrl || !this.replayHasStarted
				}
				if (!this.liveUrl || this.playState === 'error') return true
				return this.playState !== 'playing'
			},
			isMuted() {
				return !!this.mediaState.muted
			},
			isRecordingActive() {
				return ['starting', 'recording'].includes(this.mediaState.record)
			},
			isRecordingBusy() {
				return ['starting', 'recording', 'stopping'].includes(this.mediaState.record) || !!this.savingRecordingId
			},
			recordingControlLabel() {
				if (this.savingRecordingId) return '保存中'
				if (this.mediaState.record === 'starting') return '启动中'
				if (this.mediaState.record === 'recording') return '停止'
				if (this.mediaState.record === 'stopping') return '停止中'
				if (this.mediaState.record === 'ready') return '保存'
				return '录制'
			},
			recordingElapsedText() {
				return formatElapsed(this.mediaState.recordStartedAt ? this.clockNow - this.mediaState.recordStartedAt : 0)
			},
			replayClipControlLabel() {
				if (this.replayClipExporting) return '生成中'
				return this.replayClipStartSec === null ? '录制' : '完成'
			},
			replayClipElapsedText() {
				if (this.replayClipStartSec === null) return ''
				return formatElapsed(Math.max(0, this.replayMediaTime - this.replayClipStartSec) * 1000)
			},
			isTalkActive() {
				return ['starting', 'talking'].includes(this.mediaState.talk)
			},
			isRecordingActive() {
				return ['starting', 'recording', 'stopping'].includes(this.mediaState.record)
			},
			recordingElapsedText() {
				return formatElapsed(this.mediaState.recordStartedAt ? this.clockNow - this.mediaState.recordStartedAt : 0)
			},
			liveElapsedText() {
				return formatElapsed(this.liveStartedAt ? this.clockNow - this.liveStartedAt : 0)
			}
		},
		onLoad(opt) {
			if (!ensureAppSession({ message: '请先登录' })) return
			this.syncReplaySafeArea()
			this.device = JSON.parse(decodeURIComponent(opt.device || '{}'))
			const today = new Date()
			this.replayDate = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
			this.livePlaybackDiagnostics.reset({ enabled: !!this.device.liveDiagnosticsEnabled })
			this.quality = String(this.device.quality || this.quality || '0')
			if (!this.device.sn) {
				this.failPlayback('missing-device', '设备信息缺失，请返回列表刷新')
				return
			}
			this.runPlaybackFlow('initial')
			this.loadMotionAlarms()
		},
		onReady() {
			this.refreshVideoContext()
		},
		onShow() {
			this.pageVisible = true
			this.refreshDeviceMetadata()
			if (this.contentPanel === 'alerts') this.loadMotionAlarms({ silent: this.motionAlarms.length > 0 })
			if (this.contentPanel === 'replay') this.refreshInlineTimeline()
			if (this.viewerMode === 'replay') {
				if (this.inlineReplayRecord && !this.liveUrl) this.playInlineRecord(this.inlineReplayRecord)
				return
			}
			if (this.recordingRecoveryPending) this.scheduleRecordingRecovery(900)
			if (!this.resumePlaybackOnShow) return
			const reason = this.resumePlaybackReason || 'resume-from-background'
			this.resumePlaybackOnShow = false
			this.resumePlaybackReason = ''
			if (!this.device || !this.device.sn) return
			this.runPlaybackFlow(reason)
		},
		onHide() {
			this.pageVisible = false
			this.clearMotionAlarmRefresh()
			this.clearTimelineRefresh()
			if (this.viewerMode === 'replay') {
				// Native fullscreen can emit onHide on real devices. Keeping the HLS URL
				// and session alive prevents a fullscreen transition from tearing down
				// the stream and freezing on the first frame.
				return
			}
			if (typeof this.teardownLiveMedia === 'function') {
				this.teardownLiveMedia({ finalizeRecording: true })
			}
			if (this.pendingReplayNavigation) {
				this.resumePlaybackOnShow = true
				this.resumePlaybackReason = 'resume-from-replay'
				this.pendingReplayNavigation = false
			} else if (!this.leavingLivePage && this.device && this.device.sn) {
				this.resumePlaybackOnShow = true
				this.resumePlaybackReason = 'resume-from-background'
			}
			if (typeof this.teardownPlayback === 'function') this.teardownPlayback()
		},
		onUnload() {
			this.reportLivePlaybackEvent('session_ended', { source: 'app' })
			this.leavingLivePage = true
			this.pendingReplayNavigation = false
			this.resumePlaybackOnShow = false
			this.resumePlaybackReason = ''
			if (typeof this.teardownLiveMedia === 'function') {
				this.teardownLiveMedia({ finalizeRecording: true })
			}
			if (typeof this.teardownPlayback === 'function') this.teardownPlayback()
			this.clearThumbnailPoll()
			this.clearMotionAlarmImagePoll()
			this.clearMotionAlarmRefresh()
			this.clearTimelineRefresh()
			this.clearReplayRecovery()
			this.clearReplayTransientError()
			this.completeReplaySourceSwitch()
			this.clearReplayControlsTimer()
			this.cancelReplayProgressGesture()
			this.closeInlineReplaySession()
		},
		methods: {
			isCurrentVideoEvent(event) {
				const target = event && (event.currentTarget || event.target)
				const datasetGeneration = target && target.dataset && target.dataset.playerGeneration
				if (datasetGeneration !== undefined && datasetGeneration !== null && datasetGeneration !== '') {
					return Number(datasetGeneration) === Number(this.videoPlayerGeneration)
				}
				const targetId = String(target && target.id || '')
				return !targetId || targetId === this.videoPlayerId
			},
			refreshVideoContext(callback) {
				const generation = this.videoPlayerGeneration
				this.$nextTick(() => {
					if (generation !== this.videoPlayerGeneration) return
					if (typeof wx !== 'undefined' && typeof wx.createVideoContext === 'function') {
						this.videoContext = wx.createVideoContext(this.videoPlayerId, this)
					}
					if (typeof callback === 'function') callback(this.videoContext)
				})
			},
			rotateVideoPlayer() {
				this.videoPlayerGeneration += 1
				this.videoContext = null
			},
			hasDevicePermission(permission) {
				if (!this.device || this.device.role !== 'member') return true
				return Array.isArray(this.device.permissions) && this.device.permissions.includes(permission)
			},
			async refreshDeviceMetadata() {
				if (!this.device || !this.device.sn) return
				try {
					const payload = await callBackend('/api/devices')
					const latest = (payload.devices || []).find((item) => item.sn === this.device.sn)
					if (!latest) return
					this.device = Object.assign({}, this.device, {
						nickname: latest.nickname || this.device.nickname,
						role: latest.role || this.device.role,
						primaryCatId: latest.primaryCatId || '',
						primaryCatRef: latest.primaryCatRef || '',
						permissions: latest.permissions || this.device.permissions || [],
						liveDiagnosticsEnabled: !!latest.liveDiagnosticsEnabled
					})
					this.livePlaybackDiagnostics.setEnabled(!!this.device.liveDiagnosticsEnabled)
					upsertOwnedDevice(latest, uni)
				} catch (error) {
					console.warn('[live] metadata refresh failed', error && (error.code || error.message))
				}
			},
			resetLivePlaybackDiagnostics() {
				this.livePlaybackDiagnostics.reset({ enabled: !!(this.device && this.device.liveDiagnosticsEnabled) })
			},
			postLivePlaybackEvent(payload) {
				if (!payload || !this.device || !this.device.sn) return
				callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/live-playback-events', {
					method: 'POST',
					data: payload
				}).catch((error) => {
					console.warn('[live] diagnostic event unavailable', error && (error.code || error.message))
				})
			},
			reportLivePlaybackEvent(eventName, details = {}) {
				this.postLivePlaybackEvent(this.livePlaybackDiagnostics.event(eventName, details))
			},
			setPlaybackState(state, message) {
				this.playState = state
				this.statusText = message || ''
				this.mediaState = reduceMediaState(this.mediaState, { type: 'playback', playState: state })
			},
			startLiveClock() {
				if (!this.liveStartedAt) this.liveStartedAt = Date.now()
				if (this.clockTimer) return
				this.clockNow = Date.now()
				this.clockTimer = setInterval(() => {
					this.clockNow = Date.now()
				}, 1000)
			},
			stopLiveClock() {
				if (this.clockTimer) clearInterval(this.clockTimer)
				this.clockTimer = null
			},
			syncReplaySafeArea() {
				try {
					const info = uni.getSystemInfoSync && uni.getSystemInfoSync()
					const statusBarHeight = Math.max(0, Number(info && info.statusBarHeight) || 0)
					const safeArea = info && info.safeArea
					const windowHeight = Math.max(0, Number(info && (info.screenHeight || info.windowHeight)) || 0)
					const safeBottom = safeArea && windowHeight > 0 ? Math.max(0, windowHeight - Number(safeArea.bottom || windowHeight)) : 0
					this.replaySafeTopPx = Math.max(44, statusBarHeight + 18)
					this.replaySafeBottomPx = Math.max(16, safeBottom + 8)
				} catch (error) {
					this.replaySafeTopPx = 56
					this.replaySafeBottomPx = 20
				}
			},
			onFullscreenChange(event) {
				if (!this.isCurrentVideoEvent(event)) return
				const detail = (event && event.detail) || {}
				const fullScreen = detail.fullScreen === true
				const direction = detail.direction || 'vertical'
				if (this.viewerMode === 'replay') return
				const recordingWasPending = ['starting', 'recording', 'stopping'].includes(this.mediaState.record)
				this.mediaState = reduceMediaState(this.mediaState, {
					type: 'fullscreen',
					fullScreen,
					direction
				})
				console.log('[live] fullscreen change', {
					detail,
					fullScreen,
					direction,
					landscape: this.isLandscapeFullscreen
				})
				if (!fullScreen) {
					this.flushPendingRecordingSave()
					if (typeof this.teardownLiveMedia === 'function') {
						this.teardownLiveMedia({ finalizeRecording: true, recordingWasPending })
					}
					return
				}
				if (this.isLandscapeFullscreen) {
					this.traceLandscapeControlsLayout()
					this.warmupLiveRecording()
				}
			},
			traceLandscapeControlsLayout() {
				this.$nextTick(() => {
					setTimeout(() => {
						if (typeof uni === 'undefined' || typeof uni.createSelectorQuery !== 'function') {
							console.warn('[live] landscape controls layout', { error: 'SELECTOR_QUERY_UNAVAILABLE' })
							return
						}
						const query = uni.createSelectorQuery()
						const scopedQuery = query && typeof query.in === 'function' ? query.in(this) : query
						scopedQuery.select('.landscape-controls').boundingClientRect((rect) => {
							console.log('[live] landscape controls layout', {
								rendered: !!rect,
								left: rect ? rect.left : null,
								top: rect ? rect.top : null,
								width: rect ? rect.width : null,
								height: rect ? rect.height : null,
								landscape: this.isLandscapeFullscreen
							})
						}).exec()
					}, 120)
				})
			},
			exitLandscapeFullscreen() {
				if (this.isReplayFullscreen) {
					this.exitReplayFullscreen()
					return
				}
				this.videoContext && this.videoContext.exitFullScreen && this.videoContext.exitFullScreen()
			},
			enterReplayFullscreen() {
				if (this.viewerMode !== 'replay' || !this.liveUrl) return
				this.syncReplaySafeArea()
				this.replayFullscreen = true
				this.replayControlsVisible = true
				this.$nextTick(() => {
					this.applyReplayPlaybackRate()
					this.videoContext && this.videoContext.play && this.videoContext.play()
					this.refreshReplayProgressRect()
				})
				this.scheduleReplayControlsHide()
			},
			exitReplayFullscreen() {
				this.cancelReplayProgressGesture()
				this.replayFullscreen = false
				this.replayControlsVisible = true
				this.clearReplayControlsTimer()
				this.$nextTick(() => this.applyReplayPlaybackRate())
			},
			clearReplayControlsTimer() {
				if (this.replayControlsHideTimer) clearTimeout(this.replayControlsHideTimer)
				this.replayControlsHideTimer = null
			},
			cancelReplayProgressGesture() {
				const currentSec = this.replayProgressDragging
					? this.replayProgressBeforeDragSec
					: this.replayDisplaySec
				this.replayProgressDragging = false
				this.replayPendingSeekSec = currentSec
			},
			scheduleReplayControlsHide() {
				this.clearReplayControlsTimer()
				if (!this.isReplayFullscreen || this.playState !== 'playing' || this.replayProgressDragging) return
				this.replayControlsHideTimer = setTimeout(() => {
					this.replayControlsVisible = false
				}, 3200)
			},
			toggleReplayControls() {
				if (!this.isReplayFullscreen) return
				this.replayControlsVisible = !this.replayControlsVisible
				if (this.replayControlsVisible) this.scheduleReplayControlsHide()
				else this.clearReplayControlsTimer()
			},
			formatReplayProgress(sec) {
				const value = Math.max(0, Math.round(Number(sec) || 0))
				const minutes = Math.floor(value / 60)
				const seconds = value % 60
				return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
			},
			refreshReplayProgressRect() {
				return new Promise((resolve) => {
					try {
						const query = uni.createSelectorQuery && uni.createSelectorQuery()
						if (!query) return resolve(this.replayProgressRect)
						query.in(this).select('.replay-progress-track').boundingClientRect((rect) => {
							if (rect && Number(rect.width) > 0) this.replayProgressRect = { left: Number(rect.left) || 0, width: Number(rect.width) }
							resolve(this.replayProgressRect)
						}).exec()
					} catch (error) {
						resolve(this.replayProgressRect)
					}
				})
			},
			replayTouchTargetSec(event) {
				const touch = event && ((event.changedTouches && event.changedTouches[0]) || (event.touches && event.touches[0]))
				if (!touch || !this.replayDurationSec) return this.replayDisplaySec
				const rect = this.replayProgressRect || {}
				return targetSecFromTrack({
					clientX: Number(touch.clientX || touch.pageX || 0),
					left: rect.left,
					width: rect.width,
					durationSec: this.replayDurationSec
				})
			},
			onReplayProgressTouchStart(event) {
				this.clearReplayControlsTimer()
				const currentSec = this.replayDisplaySec
				const gestureId = this.replayProgressGestureId + 1
				this.replayProgressGestureId = gestureId
				this.replayProgressBeforeDragSec = currentSec
				this.replayPendingSeekSec = currentSec
				// Lock the gesture before any async selector query. On a real device a
				// fast touchend can otherwise arrive while measurement is still pending.
				this.replayProgressDragging = true
				this.replayPendingSeekSec = this.replayTouchTargetSec(event)
				if (!Number(this.replayProgressRect && this.replayProgressRect.width)) {
					this.refreshReplayProgressRect()
				}
			},
			onReplayProgressTouchMove(event) {
				if (!this.replayProgressDragging) return
				this.replayPendingSeekSec = this.replayTouchTargetSec(event)
			},
			onReplayProgressTouchEnd(event) {
				return this.commitReplayProgressGesture({
					gestureId: this.replayProgressGestureId,
					event,
					source: 'touchend'
				})
			},
			onReplayProgressTouchCancel() {
				this.replayPendingSeekSec = this.replayProgressBeforeDragSec
				this.replayProgressDragging = false
				this.scheduleReplayControlsHide()
			},
			async commitReplayProgressGesture({ gestureId, event = null, source = 'unknown' } = {}) {
				if (!this.replayProgressDragging) return
				if (!gestureId || gestureId !== this.replayProgressGestureId) return
				if (gestureId === this.replayProgressCommittedGestureId) return
				if (event) this.replayPendingSeekSec = this.replayTouchTargetSec(event)
				const targetSec = this.replayPendingSeekSec
				this.replayProgressCommittedGestureId = gestureId
				this.replayProgressDragging = false
				console.log('[replay-seek] gesture committed', { gestureId, source, targetSec })
				try {
					await this.seekReplayToSec(targetSec)
				} finally {
					if (gestureId === this.replayProgressGestureId) this.scheduleReplayControlsHide()
				}
			},
			async seekReplayToSec(targetSec) {
				const target = Math.max(0, Math.min(this.replayDurationSec, Number(targetSec) || 0))
				const previous = this.replayProgressBeforeDragSec
				await this.openDirectReplayAtSec(target, previous)
			},
			async openDirectReplayAtSec(target, previous) {
				if (!this.inlineReplayRecord) return
				const requestId = ++this.replaySeekRequestId
				const previousPlayback = {
					liveUrl: this.liveUrl,
					baseSec: this.replayBaseSec,
					mediaTime: this.replayMediaTime,
					hasStarted: this.replayHasStarted
				}
				this.replaySeekInProgress = true
				// Keep the released thumb and timestamp at the selected position while the
				// shifted direct-HLS manifest is being prepared. The currently playing URL
				// remains visible until the replacement URL is confirmed.
				this.replayBaseSec = target
				this.replayMediaTime = 0
				this.replayPendingSeekSec = target
				this.setPlaybackState('requestingReplay', '正在跳转录像...')
				try {
					const item = this.inlineReplayRecord
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/playback-url', {
						method: 'POST',
						data: {
							channel: 0,
							streamType: 0,
							mediaType: 'hls',
							protocol: 'hls',
							preferDirectHls: true,
							forceSeekableHls: false,
							startTime: item.beginTime || item.BeginTime,
							endTime: item.endTime || item.EndTime,
							fileName: item.fileName || item.FileName,
							durationSec: item.durationSec,
							targetSec: target
						}
					})
					if (requestId !== this.replaySeekRequestId) return
					const nextUrl = result.playUrl || result.url || result.streamUrl || ''
					if (!nextUrl) throw new Error('回放地址为空')
					this.inlineReplaySessionId = result.sessionId || ''
					this.inlineReplayManifestSessionId = result.manifestSessionId || ''
					this.replayTransport = result.transport || (this.inlineReplaySessionId ? 'relay' : 'direct-hls')
					this.replayBaseSec = Number.isFinite(Number(result.currentSec)) ? Number(result.currentSec) : target
					this.replayMediaTime = 0
					// Swap the source in place. Clearing src first makes the native component
					// flash a gray/error layer even though the previous HLS frame is valid.
					// Keep the rendered-frame state until the replacement emits play/timeupdate.
					this.replayHasStarted = previousPlayback.hasStarted
					this.rotateVideoPlayer()
					this.liveUrl = nextUrl
					this.refreshVideoContext(() => {
						this.applyReplayPlaybackRate()
						this.videoContext && this.videoContext.play && this.videoContext.play()
					})
					console.log('[replay-seek] direct HLS reopened', {
						targetSec: target,
						currentSec: this.replayBaseSec,
						transport: this.replayTransport,
						timings: result.timings || null
					})
				} catch (error) {
					if (requestId !== this.replaySeekRequestId) return
					this.rotateVideoPlayer()
					this.liveUrl = previousPlayback.liveUrl
					this.replayBaseSec = previousPlayback.baseSec
					this.replayMediaTime = previousPlayback.mediaTime
					this.replayHasStarted = previousPlayback.hasStarted
					this.setPlaybackState(previousPlayback.liveUrl ? 'playing' : 'error', previousPlayback.liveUrl ? '' : '录像跳转失败')
					if (previousPlayback.liveUrl) {
						this.refreshVideoContext(() => this.videoContext && this.videoContext.play && this.videoContext.play())
						uni.showToast({ title: '跳转失败，已继续原位置', icon: 'none' })
					} else {
						this.failPlayback('requestingReplay', getBackendErrorMessage(error, '录像跳转失败'), { keepUrl: true })
					}
				} finally {
					if (requestId === this.replaySeekRequestId) this.replaySeekInProgress = false
				}
			},
			handleReplayAction() {
				if (this.viewerMode === 'replay') {
					this.returnToLive()
					return
				}
				this.showReplayPanel()
			},
			formatReplayRate(rate) {
				return formatReplayPlaybackRate(rate)
			},
			applyReplayPlaybackRate() {
				if (this.viewerMode !== 'replay') return
				try {
					if (this.videoContext && this.videoContext.playbackRate) {
						this.videoContext.playbackRate(this.replayPlaybackRate)
					}
				} catch (error) {
					console.log('[live] replay playback rate failed', error)
				}
			},
			setReplayPlaybackRate(rate) {
				this.replayPlaybackRate = normalizeReplayPlaybackRate(rate)
				this.applyReplayPlaybackRate()
				this.replayControlsVisible = true
				this.scheduleReplayControlsHide()
			},
			async toggleReplayClipRecording() {
				if (!this.canRecord) {
					uni.showToast({ title: '当前共享未开放录制权限', icon: 'none' })
					return
				}
				if (this.replayClipExporting || this.viewerMode !== 'replay' || this.playState !== 'playing') return
				if (this.replayClipStartSec === null) {
					this.replayClipStartSec = Math.max(0, Number(this.replayMediaTime) || 0)
					uni.showToast({ title: '开始截取历史录像', icon: 'none' })
					return
				}
				await this.finishReplayClipRecording()
			},
			async finishReplayClipRecording(endSec = this.replayMediaTime) {
				if (this.replayClipStartSec === null || !this.inlineReplayRecord) return
				const startOffsetSec = Math.max(0, Number(this.replayClipStartSec) || 0)
				const endOffsetSec = Math.max(startOffsetSec, Number(endSec) || 0)
				this.replayClipStartSec = null
				if (endOffsetSec - startOffsetSec < 1) {
					uni.showToast({ title: '至少录制 1 秒', icon: 'none' })
					return
				}
				this.replayClipExporting = true
				uni.showToast({ title: '正在生成历史片段', icon: 'none' })
				try {
					const item = this.inlineReplayRecord
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/replay-clips', {
						method: 'POST',
						data: {
							startTime: item.beginTime || item.BeginTime,
							endTime: item.endTime || item.EndTime,
							fileName: item.fileName || item.FileName,
							startOffsetSec,
							endOffsetSec
						}
					})
					const recording = result && result.recording
					if (!recording || !recording.id) throw new Error('REPLAY_CLIP_EXPORT_FAILED')
					this.replayClipExportRecordingId = recording.id
					this.pollRecordingResult(recording.id, 0)
				} catch (error) {
					this.replayClipExporting = false
					this.replayClipExportRecordingId = ''
					uni.showToast({ title: getBackendErrorMessage(error, '历史片段生成失败'), icon: 'none' })
				}
			},
			toggleMute() {
				this.mediaState = reduceMediaState(this.mediaState, { type: 'mute.toggle' })
			},
			showMoreSettings() {
				uni.showToast({ title: '更多设置后续开放', icon: 'none' })
			},
			async ensureLiveMediaControl() {
				if (this.liveMediaControl && !this.liveMediaControl.isAuthorized()) {
					const control = this.liveMediaControl
					this.liveMediaControl = null
					this.liveMediaConnectPromise = null
					control.close()
				}
				if (this.liveMediaConnectPromise) return this.liveMediaConnectPromise
				if (!this.liveMediaControl) {
					await refreshBackendSession({ wxApi: typeof wx !== 'undefined' ? wx : null })
					this.liveMediaControl = createLiveMediaControl({
						wxApi: typeof wx !== 'undefined' ? wx : null,
						uniApi: uni,
						deviceSn: this.device.sn,
						onEvent: (event) => this.onLiveMediaEvent(event)
					})
				}
				this.liveMediaConnectPromise = this.liveMediaControl.connect().catch((error) => {
					const control = this.liveMediaControl
					this.liveMediaControl = null
					this.liveMediaConnectPromise = null
					control && control.close()
					throw error
				})
				return this.liveMediaConnectPromise
			},
			onLiveMediaEvent(event = {}) {
				const eventType = String(event.type || '')
				console.log('[live] media state event', {
					type: eventType,
					error: event.error || '',
					record: this.mediaState.record,
					talk: this.mediaState.talk
				})
				mediaActionAcknowledgements(eventType).forEach((scope) => this.liveMediaActionGuard.clear(scope))
				if (eventType === 'record.stopping') {
					this.liveMediaActionGuard.arm('record', 'finalizing', MEDIA_RECORD_FINALIZE_TIMEOUT_MS)
				}
				if (eventType === 'talk.stopping') {
					this.liveMediaActionGuard.arm('talk', 'closing', MEDIA_TALK_CLOSE_TIMEOUT_MS)
				}
				if (eventType === 'record.active') {
					if (this.mediaState.record !== 'starting') {
						this.liveMediaControl && this.liveMediaControl.stopRecording()
						return
					}
					this.mediaState = reduceMediaState(this.mediaState, {
						type: eventType,
						startedAt: Date.now(),
						id: event.id
					})
					uni.showToast({ title: '已开始录制', icon: 'success' })
					return
				}
				if (eventType === 'record.ready') {
					const belongsToCurrentRecording = this.mediaState.record !== 'starting' && (
						!this.mediaState.recording || !event.id || this.mediaState.recording.id === event.id
					)
					if (belongsToCurrentRecording) {
						this.mediaState = reduceMediaState(this.mediaState, { type: eventType, recording: event })
					}
					this.recordingRecoveryPending = false
					uni.showToast({ title: '录制已停止，正在保存', icon: 'none' })
					this.releaseAuxiliaryRecordingSession()
					this.saveCompletedRecording(event)
					return
				}
				if (eventType === 'record.idle') {
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.idle' })
					this.releaseAuxiliaryRecordingSession()
					uni.showToast({ title: '录制已停止', icon: 'none' })
					return
				}
				if (eventType === 'record.failed') {
					this.mediaState = reduceMediaState(this.mediaState, event)
					this.releaseAuxiliaryRecordingSession()
					this.showLiveMediaError(event.error)
					return
				}
				if (eventType === 'talk.failed' || eventType === 'media.error') {
					this.mediaState = reduceMediaState(this.mediaState, event)
					this.showLiveMediaError(event.error)
					return
				}
				if (eventType === 'media.failed') {
					const recordingWasPending = ['starting', 'recording', 'stopping'].includes(this.mediaState.record)
					this.mediaState = reduceMediaState(this.mediaState, event)
					if (recordingWasPending) {
						this.recordingRecoveryPending = true
						this.scheduleRecordingRecovery(1500)
					}
					this.showLiveMediaError(event.error)
					return
				}
				if (eventType === 'media.disconnected') {
					this.liveMediaActionGuard.clearAll()
					if (['starting', 'recording', 'stopping'].includes(this.mediaState.record)) {
						this.recordingRecoveryPending = true
						this.scheduleRecordingRecovery(1500)
					}
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.idle' })
					this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.idle' })
					return
				}
				this.mediaState = reduceMediaState(this.mediaState, event)
			},
			async toggleRecording() {
				if (['starting', 'recording'].includes(this.mediaState.record)) {
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.stopping' })
					this.liveMediaActionGuard.arm('record', 'stopping', MEDIA_STOP_TIMEOUT_MS)
					this.liveMediaControl && this.liveMediaControl.stopRecording()
					return
				}
				if (['stopping', 'finalizing'].includes(this.mediaState.record) || this.playState !== 'playing') return
				this.mediaState = reduceMediaState(this.mediaState, { type: 'record.starting' })
				this.liveMediaActionGuard.arm('record', 'starting', MEDIA_START_TIMEOUT_MS)
				try {
					await this.ensureLiveMediaControl()
					this.liveMediaControl.startRecording()
				} catch (error) {
					this.liveMediaActionGuard.clear('record')
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.failed', error: error.code || error.message })
					this.showLiveMediaError(error)
				}
			},
			async pollRecordingResult(recordingId, attempt) {
				if (!recordingId || attempt > 180) return
				try {
					const result = await callBackend('/api/live-recordings/' + encodeURIComponent(recordingId))
					const recording = result && result.recording
					if (recording && recording.status === 'ready' && recording.videoUrl) {
						if (recordingId === this.replayClipExportRecordingId) {
							this.replayClipExporting = false
							this.replayClipExportRecordingId = ''
						}
						this.pendingRecordingVideoUrl = recording.videoUrl
						uni.showToast({ title: '录屏已生成，正在保存', icon: 'none' })
						this.flushPendingRecordingSave()
						return
					}
					if (recording && recording.status === 'failed') {
						if (recordingId === this.replayClipExportRecordingId) {
							this.replayClipExporting = false
							this.replayClipExportRecordingId = ''
						}
						uni.showToast({ title: recording.errorCode === 'RECORDING_WINDOW_NOT_READY' ? '暂未找到设备录像，可稍后重试' : '录屏生成失败', icon: 'none' })
						return
					}
				} catch (error) {
					console.log('[live] recording status poll failed', error)
				}
				this.recordingPollTimer = setTimeout(() => this.pollRecordingResult(recordingId, attempt + 1), 1000)
			},
			async flushPendingRecordingSave() {
				const videoUrl = this.pendingRecordingVideoUrl
				if (!videoUrl) return
				this.pendingRecordingVideoUrl = ''
				try {
					await saveRemoteVideo(typeof wx !== 'undefined' ? wx : uni, videoUrl)
					uni.showToast({ title: '录屏已保存', icon: 'success' })
				} catch (error) {
					this.pendingRecordingVideoUrl = videoUrl
					uni.showToast({ title: '录屏保存失败，请重试', icon: 'none' })
				}
			},
			onLiveMediaActionTimeout({ scope, phase } = {}) {
				console.warn('[live] media action timeout', { scope, phase })
				if (scope === 'record') {
					this.mediaActionVersions.record += 1
					this.liveMediaControl && this.liveMediaControl.stopRecording()
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.idle' })
					this.recordingRecoveryPending = phase !== 'starting'
					if (this.recordingRecoveryPending) this.scheduleRecordingRecovery(1500)
					else this.releaseAuxiliaryRecordingSession()
					uni.showToast({ title: phase === 'starting' ? '录制启动超时，请重试' : '录制停止超时，正在恢复', icon: 'none' })
					return
				}
				if (scope === 'talk') {
					this.mediaActionVersions.talk += 1
					this.liveMediaControl && this.liveMediaControl.stopTalk()
					this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.idle' })
					uni.showToast({ title: phase === 'starting' ? '通话连接超时，请重试' : '通话结束超时，可重新开始', icon: 'none' })
				}
			},
			showLiveMediaError(error) {
				const code = String((error && (error.code || error.message)) || error || '')
				console.warn('[live] media control failed', {
					code,
					message: error && error.message ? String(error.message) : String(error || ''),
					stack: error && error.stack ? String(error.stack) : ''
				})
				if (code === 'MICROPHONE_PERMISSION_DENIED') {
					this.openMicrophoneSettings()
					return
				}
				const messages = {
					AUTH_REQUIRED: '登录状态已失效，请重新进入',
					MEDIA_CONTROL_DISCONNECTED: '媒体连接已断开，请重试',
					TALKBACK_FORMAT_REJECTED: '设备不接受当前音频格式',
					TALKBACK_START_FAILED: '通话连接失败，请重试',
					MICROPHONE_PERMISSION_DENIED: '请允许使用麦克风后再通话',
					MICROPHONE_PERMISSION_CHECK_FAILED: '无法检查麦克风权限，请重试',
					MICROPHONE_UNAVAILABLE: '当前设备无法使用麦克风',
					MICROPHONE_FAILED: '麦克风不可用，请检查权限',
					MEDIA_CONTROL_UNAVAILABLE: '当前环境无法连接录制服务',
					BACKEND_URL_INVALID: '本机服务地址配置有误',
					RECORDING_FAILED: '录制失败，请重试',
					RECORDING_SOURCE_FAILED: '录屏连接失败，主直播不受影响',
					LIVE_SESSION_NOT_FOUND: '当前直播暂不支持录制'
				}
				uni.showToast({ title: messages[code] || '操作失败，请重试', icon: 'none' })
			},
			openMicrophoneSettings() {
				uni.showModal({
					title: '需要麦克风权限',
					content: '开启麦克风权限后，才能把你的声音传到摄像头。',
					confirmText: '去设置',
					cancelText: '稍后',
					success: (result) => {
						if (result && result.confirm && typeof wx !== 'undefined' && wx.openSetting) {
							wx.openSetting({})
						}
					}
				})
			},
			teardownLiveMedia({ finalizeRecording = true, recordingWasPending = false } = {}) {
				this.liveMediaActionGuard.clearAll()
				const shouldRecoverRecording = recordingWasPending || ['starting', 'recording', 'stopping'].includes(this.mediaState.record)
				this.mediaActionVersions.record += 1
				this.mediaActionVersions.talk += 1
				const recordingId = this.mediaState && this.mediaState.recording && this.mediaState.recording.id
				if (finalizeRecording && recordingId && ['recording', 'stopping'].includes(this.mediaState.record)) {
					this.pollRecordingResult(String(recordingId), 0)
				}
				const control = this.liveMediaControl
				this.liveMediaControl = null
				this.liveMediaConnectPromise = null
				if (control) control.close({ finalizeRecording })
				if (finalizeRecording && shouldRecoverRecording) {
					this.recordingRecoveryPending = true
					this.scheduleRecordingRecovery(1800)
				} else {
					this.recordingPreparationGeneration += 1
					this.releaseAuxiliaryRecordingSession()
				}
				this.mediaState = reduceMediaState(this.mediaState, {
					type: 'fullscreen',
					fullScreen: false,
					direction: 'vertical'
				})
			},
			async ensureRecordingHlsSession() {
				if (this.recordingHlsSessionId) return this.recordingHlsSessionId
				if (this.currentStreamPayload && this.currentStreamPayload.source === 'backend' && this.currentStreamPayload.sessionId) {
					this.recordingHlsSessionId = this.currentStreamPayload.sessionId
					this.recordingOwnsHlsSession = false
					return this.recordingHlsSessionId
				}
				const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/livestream', {
					method: 'POST',
					data: {
						mediaType: 'hls',
						protocol: 'ts',
						channel: 0,
						stream: this.quality,
						recordingSource: true
					}
				})
				if (!result || !result.sessionId) throw new Error('LIVE_SESSION_NOT_FOUND')
				this.recordingHlsSessionId = result.sessionId
				this.recordingOwnsHlsSession = true
				return result.sessionId
			},
			prepareLiveRecording() {
				if (this.recordingPreparationPromise) return this.recordingPreparationPromise
				const generation = this.recordingPreparationGeneration
				const preparation = Promise.all([
					this.ensureLiveMediaControl().then(
						(value) => ({ ok: true, value }),
						(error) => ({ ok: false, error })
					),
					this.ensureRecordingHlsSession().then(
						(value) => ({ ok: true, value }),
						(error) => ({ ok: false, error })
					)
				]).then(([controlResult, sessionResult]) => {
					if (!controlResult.ok || !sessionResult.ok) {
						this.releaseAuxiliaryRecordingSession()
						throw controlResult.error || sessionResult.error
					}
					if (generation !== this.recordingPreparationGeneration) {
						this.releaseAuxiliaryRecordingSession()
						throw new Error('RECORDING_PREPARATION_CANCELLED')
					}
					return sessionResult.value
				})
				this.recordingPreparationPromise = preparation
				preparation.finally(() => {
					if (this.recordingPreparationPromise === preparation) this.recordingPreparationPromise = null
				}).catch(() => {})
				return preparation
			},
			warmupLiveRecording() {
				this.ensureLiveMediaControl().catch((error) => {
					if (String(error && error.message) !== 'RECORDING_PREPARATION_CANCELLED') {
						console.log('[live] recording control prewarm skipped', error)
					}
				})
			},
			async releaseAuxiliaryRecordingSession() {
				const sessionId = this.recordingOwnsHlsSession ? this.recordingHlsSessionId : ''
				this.recordingHlsSessionId = ''
				this.recordingOwnsHlsSession = false
				if (!sessionId) return
				try {
					await callBackend('/api/replay-sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
				} catch (error) {
					console.log('[live] release recording HLS failed', error)
				}
			},
			async toggleLiveRecording() {
				if (!this.canRecord) {
					uni.showToast({ title: '当前共享未开放录制权限', icon: 'none' })
					return
				}
				if (this.mediaState.record === 'ready' && this.mediaState.recording) {
					await this.saveCompletedRecording(this.mediaState.recording)
					return
				}
				if (['starting', 'recording'].includes(this.mediaState.record)) {
					this.mediaActionVersions.record += 1
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.stopping' })
					this.liveMediaActionGuard.arm('record', 'stopping', MEDIA_STOP_TIMEOUT_MS)
					this.liveMediaControl && this.liveMediaControl.stopRecording()
					uni.showToast({ title: '正在停止录制', icon: 'none' })
					return
				}
				if (this.mediaState.record === 'stopping' || this.savingRecordingId) return
				if (this.playState !== 'playing') {
					uni.showToast({ title: '直播画面尚未就绪', icon: 'none' })
					return
				}
				const actionVersion = ++this.mediaActionVersions.record
				this.mediaState = reduceMediaState(this.mediaState, { type: 'record.starting' })
				this.liveMediaActionGuard.arm('record', 'starting', MEDIA_START_TIMEOUT_MS)
				uni.showToast({ title: '正在开始录制', icon: 'none' })
				try {
					const sessionId = await this.prepareLiveRecording()
					if (actionVersion !== this.mediaActionVersions.record || this.mediaState.record !== 'starting') {
						await this.releaseAuxiliaryRecordingSession()
						return
					}
					this.liveMediaControl.startRecording(sessionId)
				} catch (error) {
					if (actionVersion !== this.mediaActionVersions.record) return
					this.liveMediaActionGuard.clear('record')
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.failed', error: error.code || error.message })
					await this.releaseAuxiliaryRecordingSession()
					this.showLiveMediaError(error)
				}
			},
			async saveCompletedRecording(recording) {
				const id = recording && recording.id
				if (!this.recordingSaveLedger.begin(id)) return
				this.savingRecordingId = id
				try {
					const result = await callBackend('/api/live-recordings/' + encodeURIComponent(id))
					const current = result && result.recording
					if (!current || current.status !== 'ready' || !current.videoUrl) throw new Error('LIVE_RECORDING_NOT_READY')
					await saveRemoteVideo(typeof wx !== 'undefined' ? wx : uni, current.videoUrl)
					this.recordingSaveLedger.succeed(id)
					this.recordingRecoveryPending = false
					this.mediaState = reduceMediaState(this.mediaState, { type: 'record.idle' })
					uni.showToast({ title: '视频已保存到相册', icon: 'success' })
				} catch (error) {
					this.recordingSaveLedger.fail(id)
					console.log('[live] recording save failed', error)
					uni.showToast({
						title: String(error.code || error.message).includes('ALBUM_PERMISSION') ? '录制已完成，请开启相册权限后重试' : '视频保存失败，请重试',
						icon: 'none'
					})
				} finally {
					this.savingRecordingId = ''
				}
			},
			async recoverLatestRecording({ autoSave = false } = {}) {
				if (!this.device.sn) return null
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/live-recordings/latest')
					const recording = result && result.recording
					if (!recording) return null
					if (recording.status === 'ready') {
						this.recordingRecoveryPending = false
						this.mediaState = reduceMediaState(this.mediaState, { type: 'record.ready', recording })
						await this.releaseAuxiliaryRecordingSession()
						if (autoSave) await this.saveCompletedRecording(recording)
					} else if (recording.status === 'failed') {
						this.recordingRecoveryPending = false
						this.mediaState = reduceMediaState(this.mediaState, { type: 'record.failed', error: recording.errorCode })
						await this.releaseAuxiliaryRecordingSession()
					}
					return recording
				} catch (error) {
					if (!String(error.message || '').includes('LIVE_RECORDING_NOT_FOUND')) {
						console.log('[live] recover recording failed', error)
					}
					return null
				}
			},
			scheduleRecordingRecovery(delayMs = 1500, attempts = 4) {
				if (this.recordingRecoveryTimer) clearTimeout(this.recordingRecoveryTimer)
				this.recordingRecoveryTimer = setTimeout(async () => {
					this.recordingRecoveryTimer = null
					await this.recoverLatestRecording({ autoSave: true })
					if (this.recordingRecoveryPending && attempts > 1) {
						this.scheduleRecordingRecovery(1200, attempts - 1)
					} else if (this.recordingRecoveryPending) {
						this.recordingRecoveryPending = false
						this.releaseAuxiliaryRecordingSession()
					}
				}, Math.max(0, Number(delayMs) || 0))
			},
			async toggleTalkback() {
				if (['starting', 'talking'].includes(this.mediaState.talk)) {
					this.mediaActionVersions.talk += 1
					this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.stopping' })
					this.liveMediaActionGuard.arm('talk', 'stopping', MEDIA_STOP_TIMEOUT_MS)
					this.liveMediaControl && this.liveMediaControl.stopTalk()
					return
				}
				if (this.mediaState.talk === 'stopping') return
				if (this.playState !== 'playing') {
					uni.showToast({ title: '直播画面尚未就绪', icon: 'none' })
					return
				}
				const actionVersion = ++this.mediaActionVersions.talk
				this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.starting' })
				this.liveMediaActionGuard.arm('talk', 'starting', MEDIA_START_TIMEOUT_MS)
				try {
					await this.ensureLiveMediaControl()
					if (actionVersion !== this.mediaActionVersions.talk || this.mediaState.talk !== 'starting') return
					const started = await this.liveMediaControl.startTalk()
					if (started === false && actionVersion === this.mediaActionVersions.talk) {
						this.liveMediaActionGuard.clear('talk')
						this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.idle' })
					}
				} catch (error) {
					if (actionVersion !== this.mediaActionVersions.talk) return
					this.liveMediaActionGuard.clear('talk')
					this.mediaState = reduceMediaState(this.mediaState, { type: 'talk.failed', error: error.code || error.message })
					this.showLiveMediaError(error)
				}
			},
			failPlayback(stage, message, options = {}) {
				if (!options.keepUrl) this.liveUrl = ''
				this.clearKeepAlive({ invalidateLogin: true })
				this.clearFirstFrameTimer()
				this.setPlaybackState('error', message)
				console.log('[live] failPlayback', { stage, message })
				this.reportLivePlaybackEvent('playback_failed', {
					source: this.currentStreamPayload && this.currentStreamPayload.source === 'backend' ? 'backend' : 'app',
					errorCode: stage
				})
			},
			isActiveRequest(requestId) {
				return requestId === this.activeRequestId
			},
			isSdkSuccess(result) {
				const code = result && (result.code || (result.data && result.data.code))
				const ret = result && (
					result.Ret ||
					(result.data && result.data.Ret) ||
					(result.data && result.data.data && result.data.data.Ret)
				)
				if (ret !== undefined && ret !== null) {
					return String(ret) === '100' && (!code || String(code) === '2000')
				}
				return String(code) === '2000'
			},
			extractLiveUrl(result) {
				if (!result) return ''
				if (result.url) return result.url
				if (result.data && result.data.url) return result.data.url
				if (result.data && result.data.data && result.data.data.url) return result.data.data.url
				return ''
			},
			callSdkWithToken(method, payload, timeoutMs = 12000) {
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
						this.JLWXSDK[method](payload, this.device.token, (result) => {
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
			async captureDeviceImage() {
				if (!this.device || !this.device.token) throw new Error('DEVICE_CAPTURE_UNAVAILABLE')
				const result = await this.callSdkWithToken('capture', buildDeviceCapturePayload(), 12000)
				const candidate = extractCoverCandidate(result)
				if (!candidate.fileId && !candidate.coverUrl && !candidate.localPath && !candidate.base64Data) {
					const error = new Error('DEVICE_CAPTURE_EMPTY')
					error.captureSummary = summarizeCaptureResult(result)
					throw error
				}
				return candidate
			},
			async saveCapturedDeviceCover(candidate) {
				const saved = await persistDeviceCover({
					sn: this.device.sn,
					candidate,
					wxApi: typeof wx !== 'undefined' ? wx : null,
					saveCover: (payload) => callDemoData('saveDeviceCover', payload)
				})
				if (!saved || !saved.ok) throw new Error((saved && saved.error) || 'DEVICE_COVER_SAVE_FAILED')
				const cover = saved.cover || {}
				const coverUrl = String(cover.coverUrl || cover.localPath || '')
				if (coverUrl) {
					const coverUpdatedAt = Number(cover.updatedAt || cover.capturedAt) || Date.now()
					this.device = Object.assign({}, this.device, { coverUrl, coverUpdatedAt })
					upsertOwnedDevice(this.device, uni)
				}
				return saved
			},
			async captureDeviceCoverOnce() {
				if (this.coverCaptureAttempted || this.coverCaptureInFlight || this.playState !== 'playing') return false
				const health = this.playbackHealthTracker.snapshot(Date.now())
				if (health.stalled || health.lastAdvanceAgoMs > 1500 || health.mediaTimeSec < 8) {
					console.log('[live] device cover deferred until playback is stable', {
						mediaTimeSec: health.mediaTimeSec,
						lastAdvanceAgoMs: health.lastAdvanceAgoMs,
						stalled: health.stalled
					})
					return false
				}
				this.coverCaptureAttempted = true
				this.coverCaptureInFlight = true
				try {
					const candidate = await this.captureDeviceImage()
					await this.saveCapturedDeviceCover(candidate)
					console.log('[live] device cover saved', { sn: this.device.sn })
					return true
				} catch (error) {
					console.log('[live] device cover capture skipped', {
						error: error && error.message ? error.message : String(error),
						capture: error && error.captureSummary ? error.captureSummary : null,
						captureJson: error && error.captureSummary ? JSON.stringify(error.captureSummary) : ''
					})
					return false
				} finally {
					this.coverCaptureInFlight = false
				}
			},
			async captureLiveImage() {
				if (!this.canCapture) {
					uni.showToast({ title: '当前共享未开放截图权限', icon: 'none' })
					return
				}
				if (this.snapshotInFlight) return
				this.snapshotInFlight = true
				let capturedCandidate = null
				try {
					const candidate = await this.captureDeviceImage()
					capturedCandidate = candidate
					const source = await materializeCoverCandidate({
						candidate,
						wxApi: typeof wx !== 'undefined' ? wx : null,
						sn: this.device.sn
					})
					if (!source) throw new Error('DEVICE_CAPTURE_IMAGE_UNAVAILABLE')
					await saveRemoteImage(typeof wx !== 'undefined' ? wx : uni, source)
					this.saveCapturedDeviceCover(candidate).catch((error) => {
						console.log('[live] manual screenshot cover save skipped', error)
					})
					uni.showToast({ title: '截图已保存', icon: 'success' })
				} catch (error) {
					const cause = error && error.cause && error.cause.cause ? error.cause.cause : (error && error.cause)
					const imageHost = capturedCandidate && capturedCandidate.coverUrl
						? String(capturedCandidate.coverUrl).replace(/^(https?:\/\/[^/]+).*$/, '$1')
						: ''
					const downloadSummary = {
						imageHost,
						code: cause && cause.code ? cause.code : '',
						errMsg: cause && cause.errMsg ? cause.errMsg : '',
						statusCode: cause && cause.statusCode ? cause.statusCode : 0,
						message: cause && cause.message ? cause.message : ''
					}
					console.log('[live] direct device capture failed', {
						error: error && error.message ? error.message : String(error),
						capture: error && error.captureSummary ? error.captureSummary : null,
						captureJson: error && error.captureSummary ? JSON.stringify(error.captureSummary) : '',
						imageHost,
						cause: cause ? {
							code: cause.code || '',
							errMsg: cause.errMsg || '',
							statusCode: cause.statusCode || 0,
							message: cause.message || ''
						} : null,
						downloadJson: JSON.stringify(downloadSummary)
					})
					console.log('[live] screenshot failure detail', JSON.stringify({
						error: error && error.message ? error.message : String(error),
						...downloadSummary
					}))
					uni.showToast({ title: '截图失败，请重试', icon: 'none' })
				} finally {
					this.snapshotInFlight = false
				}
			},
			startKeepAlive() {
				this.clearKeepAlive()
				if (!this.device.token) return
				this.keepAliveTimer = setInterval(() => {
					this.JLWXSDK.keepAlive(this.device.token, () => {})
				}, KEEPALIVE_INTERVAL_MS)
			},
			clearKeepAlive({ invalidateLogin = false } = {}) {
				if (this.keepAliveTimer) {
					clearInterval(this.keepAliveTimer)
					this.keepAliveTimer = null
				}
				if (invalidateLogin) {
					this.deviceLoginReady = false
					this.deviceLoginToken = ''
				}
			},
			async requestLivePriority() {
				if (!this.device || !this.device.sn) return null
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/live-priority', {
						method: 'POST',
						data: { holdMs: LIVE_PRIORITY_HOLD_MS }
					})
					if (Number(result && result.stoppedReplaySessions) > 0) {
						console.log('[live] background analysis stream preempted', {
							sn: this.device.sn,
							stoppedReplaySessions: Number(result.stoppedReplaySessions)
						})
					}
					return result
				} catch (error) {
					console.log('[live] priority request unavailable', {
						message: error && error.message ? error.message : String(error || '')
					})
					return null
				}
			},
			startLivePriority() {
				this.clearLivePriority()
				if (this.viewerMode !== 'live') return
				this.requestLivePriority()
				this.livePriorityTimer = setInterval(() => {
					this.requestLivePriority()
				}, LIVE_PRIORITY_REFRESH_MS)
			},
			clearLivePriority() {
				if (this.livePriorityTimer) clearInterval(this.livePriorityTimer)
				this.livePriorityTimer = null
			},
			resetPlaybackHealth() {
				this.clearPlaybackHealth()
				this.playbackHealthTracker.start({ nowMs: Date.now(), mediaTimeSec: 0 })
			},
			startPlaybackHealth() {
				if (this.playbackHealthTimer) return
				this.playbackHealthTimer = setInterval(() => {
					const health = this.playbackHealthTracker.snapshot(Date.now())
					console.log('[live] playback health', {
						source: this.currentStreamPayload && this.currentStreamPayload.source,
						mediaTimeSec: health.mediaTimeSec,
						lastAdvanceAgoMs: health.lastAdvanceAgoMs,
						stalled: health.stalled,
						activeStallMs: health.activeStallMs,
						totalStallMs: health.totalStallMs,
						longestStallMs: health.longestStallMs,
						waitingEvents: health.waitingEvents,
						recordingSourceReady: !!this.recordingHlsSessionId
					})
					this.recoverStalledSdkPlayback(health)
				}, PLAYBACK_HEALTH_INTERVAL_MS)
			},
			async recoverStalledSdkPlayback(health = {}) {
				const source = this.currentStreamPayload && this.currentStreamPayload.source
				if (source !== 'sdk') return false
				if (!health.stalled || health.activeStallMs < PLAYBACK_RECOVERY_STALL_MS) return false
				if (this.stallRecoveryInProgress || this.leavingLivePage || this.pendingReplayNavigation) return false
				if (this.isRecordingBusy || this.isTalkActive) return false
				if (this.stallRecoveryAttempts >= PLAYBACK_RECOVERY_MAX_ATTEMPTS) return false
				if (this.attemptedPlaybackRoutes.has('backend')) return false
				const now = Date.now()
				if (now - this.lastStallRecoveryAt < PLAYBACK_RECOVERY_COOLDOWN_MS) return false
				this.stallRecoveryInProgress = true
				this.stallRecoveryAttempts += 1
				this.lastStallRecoveryAt = now
				const guardRequestId = this.activeRequestId
				const failedPayload = this.currentStreamPayload
				console.log('[live] measured stall recovery', {
					attempt: this.stallRecoveryAttempts,
					activeStallMs: health.activeStallMs,
					mediaTimeSec: health.mediaTimeSec
				})
				try {
					this.attemptedPlaybackRoutes.add('backend')
					const stream = await this.requestBackendLiveUrl(guardRequestId)
					if (!stream.ok || this.activeRequestId !== guardRequestId || this.leavingLivePage) return false
					this.currentStreamPayload = stream.payload
					this.liveUrl = stream.url
					this.statusText = '正在连接画面...'
					await this.closeCurrentStream({ payload: failedPayload, clearUrl: false })
					return true
				} finally {
					this.stallRecoveryInProgress = false
				}
			},
			clearPlaybackHealth() {
				if (this.playbackHealthTimer) clearInterval(this.playbackHealthTimer)
				this.playbackHealthTimer = null
			},
			clearFirstFrameTimer() {
				if (this.firstFrameTimer) {
					clearTimeout(this.firstFrameTimer)
					this.firstFrameTimer = null
				}
			},
			clearCoverCaptureTimer() {
				if (this.coverCaptureTimer) {
					clearTimeout(this.coverCaptureTimer)
					this.coverCaptureTimer = null
				}
			},
			buildCloseStreamPayload(payload = this.currentStreamPayload) {
				return {
					channel: String((payload && payload.channel) || '0'),
					stream: String((payload && payload.stream) || this.quality || '0'),
					username: this.device.username || 'admin',
					password: this.device.password || ''
				}
			},
			async closeCurrentStream({ payload = this.currentStreamPayload, clearUrl = false } = {}) {
				const closingCurrentPayload = payload === this.currentStreamPayload
				const closingSessionId = String((payload && payload.sessionId) || '')
				if (clearUrl && closingCurrentPayload) this.liveUrl = ''
				if (payload && payload.source === 'backend') {
					try {
						if (payload.sessionId) {
							await callBackend('/api/replay-sessions/' + encodeURIComponent(payload.sessionId), { method: 'DELETE' })
						}
					} catch (error) {
						console.log('[live] close backend hls failed', error)
					} finally {
						if (!this.recordingOwnsHlsSession && closingSessionId && this.recordingHlsSessionId === closingSessionId) {
							this.recordingHlsSessionId = ''
						}
						if (payload === this.currentStreamPayload) this.currentStreamPayload = null
					}
					return
				}
				if (!this.device.token) {
					return
				}
				try {
					await this.callSdkWithToken('closeLivestream', this.buildCloseStreamPayload(payload), 8000)
				} catch (error) {
					console.log('[live] closeLivestream failed', error)
				} finally {
					if (payload === this.currentStreamPayload) this.currentStreamPayload = null
				}
			},
			teardownPlayback() {
				this.activeRequestId += 1
				this.clearKeepAlive({ invalidateLogin: true })
				this.clearLivePriority()
				this.clearPlaybackHealth()
				this.clearFirstFrameTimer()
				this.clearCoverCaptureTimer()
				this.stopLiveClock()
				this.liveStartedAt = 0
				this.closeCurrentStream({ clearUrl: true })
			},
			buildDeviceLoginPayload() {
				const payload = {
					EncryptType: 'DISABLE',
					LoginType: 'DVRIP-Web',
					PassWord: this.device.password || '',
					UserName: this.device.username || 'admin',
					Name: 'generalinfo',
					KeepaliveTime: 20
				}
				if (this.device.loginToken) {
					payload.LoginToken = this.device.loginToken
					payload.EncryptType = 'TOKEN'
				} else if (!payload.PassWord) {
					payload.EncryptType = 'MD5'
				}
				return payload
			},
			async loginDevice(requestId, options = {}) {
				if (!this.device.token) {
					this.reportLivePlaybackEvent('device_login_failed', { source: 'sdk', errorCode: 'MISSING_DEVICE_TOKEN' })
					if (this.isActiveRequest(requestId) && !options.silent) this.failPlayback('missing-token', '设备令牌缺失，请返回列表刷新')
					return false
				}
				if (this.deviceLoginReady && this.keepAliveTimer && this.deviceLoginToken === this.device.token) {
					return true
				}
				this.setPlaybackState('deviceLogin', '正在登录设备...')
				try {
					const result = await this.callSdkWithToken('deviceLogin', this.buildDeviceLoginPayload(), 15000)
					if (!this.isActiveRequest(requestId)) return false
					if (!this.isSdkSuccess(result)) {
						this.reportLivePlaybackEvent('device_login_failed', {
							source: 'sdk',
							errorCode: extractLivePlaybackErrorCode({ result })
						})
						if (!options.silent) this.failPlayback('deviceLogin', '设备登录失败，请稍后重试')
						return false
					}
					this.reportLivePlaybackEvent('device_login_succeeded', { source: 'sdk' })
				} catch (error) {
					console.log('[live] deviceLogin failed', error)
					this.reportLivePlaybackEvent('device_login_failed', {
						source: 'sdk',
						errorCode: extractLivePlaybackErrorCode({ error })
					})
					if (this.isActiveRequest(requestId) && !options.silent) this.failPlayback('deviceLogin', '设备登录失败，请稍后重试')
					return false
				}
				this.startKeepAlive()
				this.deviceLoginReady = true
				this.deviceLoginToken = this.device.token
				return true
			},
			buildStreamPayload(candidate) {
				const payload = {
					mediaType: candidate.mediaType,
					channel: candidate.channel,
					stream: candidate.stream,
					protocol: candidate.protocol,
					username: candidate.username,
					password: candidate.password
				}
				if (this.device.loginToken) {
					payload.authentication = this.device.loginToken
					payload.encryptType = 'TOKEN'
				}
				return payload
			},
			buildStreamAttempts() {
				const plan = buildLivestreamPlan({
					platform: process.env.UNI_PLATFORM || '',
					quality: this.quality,
					username: this.device.username || 'admin',
					password: this.device.password || ''
				})
				const attempts = [{ candidate: plan.primary, fallback: false }]
				const fallback = plan.fallback || null
				if (fallback && fallback.key !== plan.primary.key) {
					attempts.push({ candidate: fallback, fallback: true })
				}
				return attempts
			},
			async retryLivestreamCandidate(payload, requestId) {
				this.setPlaybackState('requestingFallbackStream', '媒体线路暂时拥堵，正在重试...')
				await delay(LIVESTREAM_RETRY_DELAY_MS)
				if (!this.isActiveRequest(requestId)) return null
				return this.callSdkWithToken('livestream', payload, 15000)
			},
			async requestLiveUrl(requestId) {
				const attempts = this.buildStreamAttempts()
				let lastErrorCode = 'STREAM_URL_UNAVAILABLE'
				for (const attempt of attempts) {
					this.setPlaybackState(
						attempt.fallback ? 'requestingFallbackStream' : 'requestingPrimaryStream',
						attempt.fallback ? '正在尝试备用线路...' : '正在获取直播地址...'
					)
					const payload = this.buildStreamPayload(attempt.candidate)
					try {
						let result = await this.callSdkWithToken('livestream', payload, 15000)
						if (!this.isActiveRequest(requestId)) return { ok: false, cancelled: true }
						if (isTransientLivestreamFailure(result)) {
							console.log('[live] transient xmts route failure, retry candidate', {
								key: attempt.candidate.key
							})
							result = await this.retryLivestreamCandidate(payload, requestId)
							if (!this.isActiveRequest(requestId)) return { ok: false, cancelled: true }
						}
						const url = this.extractLiveUrl(result)
						if (this.isSdkSuccess(result) && url) {
							this.reportLivePlaybackEvent('stream_url_succeeded', { source: 'sdk' })
							return { ok: true, url, payload: Object.assign({ source: 'sdk' }, payload) }
						}
						lastErrorCode = extractLivePlaybackErrorCode({ result })
						console.log('[live] livestream candidate failed', { key: attempt.candidate.key, result })
					} catch (error) {
						lastErrorCode = extractLivePlaybackErrorCode({ error })
						console.log('[live] livestream candidate failed', { key: attempt.candidate.key, error })
					}
				}
				this.reportLivePlaybackEvent('stream_url_failed', { source: 'sdk', errorCode: lastErrorCode })
				return { ok: false }
			},
			async requestBackendLiveUrl(requestId) {
				this.setPlaybackState('requestingBackendStream', '正在连接画面...')
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/livestream', {
						method: 'POST',
						data: {
							mediaType: 'hls',
							protocol: 'ts',
							channel: '0',
							stream: this.quality,
							playbackSource: true,
							sharedSource: this.device.role === 'member'
						}
					})
					if (!this.isActiveRequest(requestId)) return { ok: false, cancelled: true }
					const url = this.extractLiveUrl(result)
					if (result && result.ok && url) {
						this.reportLivePlaybackEvent('stream_url_succeeded', { source: 'backend' })
						return {
							ok: true,
							url,
							payload: {
								source: 'backend',
								sessionId: result.sessionId || '',
								channel: '0',
								stream: this.quality,
								transport: result.transport || 'official-hls-playback-source'
							}
						}
					}
					this.reportLivePlaybackEvent('stream_url_failed', { source: 'backend', errorCode: 'BACKEND_LIVESTREAM_FAILED' })
					return { ok: false, error: new Error('BACKEND_LIVESTREAM_FAILED') }
				} catch (error) {
					console.log('[live] backend livestream fallback failed', {
						error: error && error.message ? error.message : String(error)
					})
					this.reportLivePlaybackEvent('stream_url_failed', {
						source: 'backend',
						errorCode: extractLivePlaybackErrorCode({ error })
					})
					return { ok: false, error }
				}
			},
			async runPlaybackFlow(reason = 'manual', options = {}) {
				if (this.playbackConnectPromise) return this.playbackConnectPromise
				const request = this.executePlaybackFlow(reason, options)
				this.playbackConnectPromise = request
				try {
					return await request
				} finally {
					if (this.playbackConnectPromise === request) this.playbackConnectPromise = null
				}
			},
			async executePlaybackFlow(reason = 'manual', options = {}) {
				if (!ensureAppSession({ message: '请先登录' })) return false
				if (this.viewerMode !== 'live') return false
				this.resetLivePlaybackDiagnostics()
				this.reportLivePlaybackEvent('session_started', { source: 'app' })
				this.startLivePriority()
				this.resetPlaybackHealth()
				this.coverCaptureAttempted = false
				this.sdkFallbackAttempted = false
				this.sdkFallbackInProgress = false
				if (!options.preserveAttempts) this.attemptedPlaybackRoutes = new Set()
				const requestId = this.activeRequestId + 1
				this.activeRequestId = requestId
				this.clearFirstFrameTimer()
				this.clearCoverCaptureTimer()
				if (!options.preserveUrl) this.liveUrl = ''
				try {
					let stream = { ok: false }
					const routeOrder = buildRouteOrder(this.device.sn, uni)
					for (const route of routeOrder) {
						if (!this.isActiveRequest(requestId) || this.attemptedPlaybackRoutes.has(route)) continue
						this.attemptedPlaybackRoutes.add(route)
						if (route === 'sdk') {
							try {
								if (this.device.role === 'member') {
									const sharedAccessReady = await this.resolveSharedLiveToken(requestId)
									if (!sharedAccessReady || !this.isActiveRequest(requestId)) continue
								}
								const loggedIn = await this.loginDevice(requestId, { silent: true })
								if (loggedIn && this.isActiveRequest(requestId)) stream = await this.requestLiveUrl(requestId)
							} catch (error) {
								stream = { ok: false, error }
							}
						} else {
							stream = await this.requestBackendLiveUrl(requestId)
						}
						if (stream.ok || options.sdkOnly) break
					}
					if (!this.isActiveRequest(requestId)) return false
					if (!stream.ok) {
						if (!options.keepPreviousOnFailure) {
							const message = getBackendErrorMessage(stream.error, '获取直播地址失败，请确认设备在线后重试')
							this.failPlayback('requestingBackendStream', message)
						}
						return false
					}
					this.currentStreamPayload = stream.payload
					if (stream.payload && stream.payload.source === 'backend') this.clearKeepAlive({ invalidateLogin: true })
					this.lastVideoProgressAt = Date.now()
					this.liveUrl = stream.url
					this.statusText = '正在加载画面...'
					return true
				} catch (error) {
					console.log('[live] playback flow failed', { reason, error })
					if (this.isActiveRequest(requestId) && !options.keepPreviousOnFailure) {
						this.failPlayback(
							error && error.code ? error.code : 'requestingPrimaryStream',
							error && error.message ? error.message : '获取直播地址失败，可重试'
						)
					}
					return false
				}
			},
			showModalAsync(options) {
				return new Promise((resolve) => {
					uni.showModal(Object.assign({}, options, { success: resolve, fail: () => resolve({ confirm: false }) }))
				})
			},
			async queryDeviceTime() {
				if (this.device.token) {
					try {
						const result = await this.callSdkWithToken('opdev', { Name: 'OPTimeQuery' }, 12000)
						const deviceTime = extractDeviceTime(result)
						if (deviceTime) return deviceTime
					} catch (error) {
						console.log('[live] SDK OPTimeQuery failed', error)
					}
				}
				const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/time')
				return (result && result.deviceTime) || extractDeviceTime(result) || ''
			},
			async checkDeviceTimeAfterFirstFrame() {
				if (this.timeSyncPromptShown || !this.device.token) return
				try {
					const deviceTime = await this.queryDeviceTime()
					if (!shouldPromptTimeSync({ deviceTime, promptShown: this.timeSyncPromptShown })) return
					this.timeSyncPromptShown = true
					const driftText = deviceTime ? `设备时间 ${deviceTime} 与手机时间相差超过 2 分钟。` : '设备时间与手机时间相差超过 2 分钟。'
					const res = await this.showModalAsync({
						title: '同步设备时间',
						content: `${driftText}是否立即同步？`,
						confirmText: '同步',
						cancelText: '暂不'
					})
					if (res.confirm) await this.syncDeviceTime()
				} catch (error) {
					console.log('[live] OPTimeQuery failed', error)
				}
			},
			async syncDeviceTimeWithBackend(payload) {
				const deviceTime = payload.OPTimeSetting || payload.OPUTCTimeSetting || ''
				const mode = payload.OPUTCTimeSetting ? 'utc' : 'local'
				await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/time-sync', {
					method: 'POST',
					data: { mode, deviceTime }
				})
				return true
			},
			async syncDeviceTime() {
				try {
					const payload = buildTimeSyncPayload('local')
					if (!payload.OPTimeSetting && !payload.OPUTCTimeSetting) {
						uni.showToast({ title: '时间同步参数异常', icon: 'none' })
						return false
					}
					if (this.currentStreamPayload && this.currentStreamPayload.source === 'backend') {
						await this.syncDeviceTimeWithBackend(payload)
					} else {
						const result = await this.callSdkWithToken('opdev', payload, 12000)
						if (!this.isSdkSuccess(result)) {
							await this.syncDeviceTimeWithBackend(payload)
						}
					}
					uni.showToast({ title: '时间已同步', icon: 'success' })
					await this.closeCurrentStream({ clearUrl: true })
					await this.runPlaybackFlow('time-sync')
					return true
				} catch (error) {
					console.log('[live] syncDeviceTime failed', error)
					uni.showToast({ title: '时间同步失败', icon: 'none' })
					return false
				}
			},
			retryPlayback() {
				if (this.viewerMode === 'replay' && this.inlineReplayRecord) {
					this.playInlineRecord(this.inlineReplayRecord)
					return
				}
				this.stallRecoveryAttempts = 0
				this.lastStallRecoveryAt = 0
				this.runPlaybackFlow('retry')
			},
			goBack() {
				if (this.isReplayFullscreen) {
					this.exitReplayFullscreen()
					return
				}
				this.leavingLivePage = true
				this.resumePlaybackOnShow = false
				this.resumePlaybackReason = ''
				if (typeof this.teardownLiveMedia === 'function') {
					this.teardownLiveMedia({ finalizeRecording: true })
				}
				if (typeof this.teardownPlayback === 'function') {
					this.teardownPlayback()
				} else {
					this.activeRequestId += 1
					if (typeof this.clearKeepAlive === 'function') this.clearKeepAlive()
					if (typeof this.clearFirstFrameTimer === 'function') this.clearFirstFrameTimer()
					if (typeof this.closeCurrentStream === 'function') this.closeCurrentStream({ clearUrl: true })
				}
				uni.navigateBack()
			},
			goReplay() {
				if (this.viewerMode === 'replay') {
					this.returnToLive()
					return
				}
				this.replayExpanded = !this.replayExpanded
				if (this.replayExpanded && this.replayRecords.length === 0) this.loadInlineRecordings()
			},
			showAlertPanel() {
				this.contentPanel = 'alerts'
				this.clearTimelineRefresh()
				this.loadMotionAlarms({ silent: this.motionAlarms.length > 0 })
			},
			showReplayPanel() {
				this.contentPanel = 'replay'
				this.clearMotionAlarmRefresh()
				this.replayExpanded = true
				if (this.replayRecords.length === 0) this.loadInlineRecordings()
				else this.refreshInlineTimeline()
			},
			async onAlertDateChange(event) {
				this.replayDate = event.detail.value
				this.timelineRevision = ''
				this.motionAlarmRevision = ''
				this.replayRecords = []
				this.clearMotionAlarmImagePoll()
				await this.loadMotionAlarms()
			},
			clearMotionAlarmImagePoll() {
				if (this.motionAlarmImagePollTimer) clearTimeout(this.motionAlarmImagePollTimer)
				this.motionAlarmImagePollTimer = null
			},
			clearMotionAlarmRefresh() {
				if (this.motionAlarmRefreshTimer) clearTimeout(this.motionAlarmRefreshTimer)
				this.motionAlarmRefreshTimer = null
			},
			scheduleMotionAlarmRefresh() {
				this.clearMotionAlarmRefresh()
				if (!this.pageVisible || this.contentPanel !== 'alerts') return
				this.motionAlarmRefreshTimer = setTimeout(
					() => this.loadMotionAlarms({ silent: true }),
					8000
				)
			},
			scheduleMotionAlarmImagePoll() {
				this.clearMotionAlarmImagePoll()
				const hasPendingImage = this.motionAlarms.some((alarm) =>
					!alarm.imageUrl && ['missing', 'pending'].includes(String(alarm.imageState || ''))
				)
				if (!hasPendingImage) return
				this.motionAlarmImagePollTimer = setTimeout(
					() => this.loadMotionAlarms({ silent: true }),
					4000
				)
			},
			async loadMotionAlarms(options = {}) {
				if (!this.device.sn || this.motionAlertsLoading) return
				this.motionAlertsLoading = true
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/motion-alerts', {
						query: { date: this.replayDate, limit: 50, since: this.motionAlarmRevision }
					})
					if (!result.unchanged) {
						this.motionAlarms = Array.isArray(result.alarms) ? result.alarms : this.motionAlarms
					}
					this.motionAlarmRevision = result.revision || this.motionAlarmRevision
					this.motionAlertPreference = result.preference || { enabled: true }
					this.scheduleMotionAlarmImagePoll()
				} catch (error) {
					console.log('[live] motion alarms failed', error)
					if (!options.silent) uni.showToast({ title: getBackendErrorMessage(error, '移动警报读取失败'), icon: 'none' })
				} finally {
					this.motionAlertsLoading = false
					this.scheduleMotionAlarmRefresh()
				}
			},
			formatAlarmTime(value) {
				const text = String(value || '')
				return text.includes(' ') ? text.split(' ')[1] : text || '时间未知'
			},
			clearThumbnailPoll() {
				if (this.thumbnailPollTimer) clearTimeout(this.thumbnailPollTimer)
				this.thumbnailPollTimer = null
			},
			clearTimelineRefresh() {
				if (this.timelineRefreshTimer) clearTimeout(this.timelineRefreshTimer)
				this.timelineRefreshTimer = null
			},
			scheduleTimelineRefresh() {
				this.clearTimelineRefresh()
				if (!this.pageVisible || this.contentPanel !== 'replay') return
				this.timelineRefreshTimer = setTimeout(() => this.refreshInlineTimeline(), 8000)
			},
			applyTimelineResult(timelineResult, records = this.replayRecords) {
				if (!timelineResult.unchanged) {
					this.replayDayMarkers = Array.isArray(timelineResult.markers) ? timelineResult.markers : this.replayDayMarkers
					this.replayDayMeals = Array.isArray(timelineResult.diary && timelineResult.diary.meals)
						? timelineResult.diary.meals
						: this.replayDayMeals
					if (Array.isArray(timelineResult.alarms)) this.motionAlarms = timelineResult.alarms
					this.timelineAnalysisStatus = Array.isArray(timelineResult.analysisStatus)
						? timelineResult.analysisStatus
						: this.timelineAnalysisStatus
				}
				this.timelineRevision = timelineResult.revision || this.timelineRevision
				const attached = attachReplayMarkers(records, this.replayDayMarkers, this.timelineAnalysisStatus)
				const byKey = attached.reduce((map, item) => {
					map[item.recordingKey] = item
					return map
				}, {})
				this.replayRecords = records.map((record) => {
					const key = buildRecordingKey(record)
					return byKey[key] || Object.assign({}, record, { recordingKey: key, markers: [] })
				})
			},
			async refreshInlineTimeline() {
				if (!this.device.sn || this.timelineLoading) return
				this.timelineLoading = true
				try {
					const timelineResult = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/timeline', {
						query: { date: this.replayDate, since: this.timelineRevision }
					})
					this.applyTimelineResult(timelineResult)
				} catch (error) {
					console.log('[live] timeline refresh failed', error)
				} finally {
					this.timelineLoading = false
					this.scheduleTimelineRefresh()
				}
			},
			scheduleThumbnailPoll() {
				this.clearThumbnailPoll()
				const hasWorking = this.replayRecords.some((item) => item.thumbnailState === 'pending' || item.thumbnailState === 'missing')
				const hasRetryableError = this.replayRecords.some((item) => item.thumbnailState === 'error')
				if (!hasWorking && !hasRetryableError) return
				this.thumbnailPollTimer = setTimeout(
					() => this.loadInlineRecordings({ silent: true }),
					hasWorking ? 4000 : 30000
				)
			},
			async onInlineReplayDateChange(event) {
				this.replayDate = event.detail.value
				this.timelineRevision = ''
				this.motionAlarmRevision = ''
				this.motionAlarms = []
				this.replayDayMarkers = []
				this.replayDayMeals = []
				this.timelineAnalysisStatus = []
				await this.loadInlineRecordings()
			},
			async loadInlineRecordings(options = {}) {
				if (!this.device.sn || this.replayLoading) return
				if (!options.silent) this.replayLoading = true
				try {
					const date = new Date(this.replayDate)
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/recordings', {
						query: { beginTime: formatDate(date, true), endTime: formatDate(date, false, true), channel: 0 }
					})
					const records = (Array.isArray(result.recordings) ? result.recordings : []).slice().reverse()
					try {
						const timelineResult = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/timeline', {
							query: { date: this.replayDate, since: this.timelineRevision }
						})
						this.applyTimelineResult(timelineResult, records)
					} catch (markerError) {
						console.log('[live] replay markers failed', markerError)
						// Keep the last good timeline during transient tunnel/server failures.
						this.replayRecords = records.map((record) => Object.assign({}, record, {
							recordingKey: buildRecordingKey(record),
							markers: (this.replayRecords.find((item) => item.recordingKey === buildRecordingKey(record)) || {}).markers || []
						}))
					}
					this.scheduleThumbnailPoll()
					this.scheduleTimelineRefresh()
				} catch (error) {
					if (!options.silent) uni.showToast({ title: getBackendErrorMessage(error, '录像读取失败'), icon: 'none' })
				} finally {
					this.replayLoading = false
				}
			},
			formatInlineRecordTime(item) {
				const value = String(item.beginTime || item.BeginTime || '')
				return value.includes(' ') ? value.split(' ')[1].slice(0, 5) : value || '录像片段'
			},
			formatInlineDuration(item) {
				return formatDurationLabel(Number(item.durationSec || item.duration || 0))
			},
			async stopLiveForInlineReplay() {
				this.activeRequestId += 1
				this.clearKeepAlive()
				this.clearLivePriority()
				this.clearPlaybackHealth()
				this.clearFirstFrameTimer()
				this.clearCoverCaptureTimer()
				this.stopLiveClock()
				const livePayload = this.currentStreamPayload
				this.currentStreamPayload = null
				const closePromise = this.closeCurrentStream({ payload: livePayload, clearUrl: false })
				await Promise.race([
					closePromise,
					new Promise((resolve) => setTimeout(resolve, 600))
				])
			},
			clearReplayRecovery() {
				if (this.replayRecoveryTimer) clearTimeout(this.replayRecoveryTimer)
				this.replayRecoveryTimer = null
			},
			clearReplayTransientError() {
				if (this.replayTransientErrorTimer) clearTimeout(this.replayTransientErrorTimer)
				this.replayTransientErrorTimer = null
			},
			completeReplaySourceSwitch() {
				if (this.replaySourceSwitchTimer) clearTimeout(this.replaySourceSwitchTimer)
				this.replaySourceSwitchTimer = null
				this.replaySourceSwitching = false
			},
			armReplaySourceSwitchTimeout() {
				if (this.replaySourceSwitchTimer) clearTimeout(this.replaySourceSwitchTimer)
				this.replaySourceSwitchTimer = setTimeout(() => {
					this.replaySourceSwitchTimer = null
					if (!this.replaySourceSwitching || this.viewerMode !== 'replay') return
					this.replaySourceSwitching = false
					if (!this.replayHasStarted) this.failPlayback('requestingReplay', '录像加载失败，请重试')
				}, 10000)
			},
			scheduleReplayRecovery(delayMs = REPLAY_STALL_RECOVERY_MS) {
				if (this.viewerMode !== 'replay' || !this.inlineReplaySessionId) return
				this.clearReplayRecovery()
				this.replayRecoveryTimer = setTimeout(() => {
					this.replayRecoveryTimer = null
					this.recoverReplayPlayback()
				}, Math.max(0, Number(delayMs) || 0))
			},
			async recoverReplayPlayback() {
				if (this.viewerMode !== 'replay' || !this.inlineReplaySessionId || this.replayRecoveryInProgress) return
				if (this.replayLastProgressAt && Date.now() - this.replayLastProgressAt < 2500) return
				if (this.replayRecoveryAttempts >= REPLAY_RECOVERY_MAX_ATTEMPTS) {
					this.failPlayback('replay', '录像播放中断，请重试')
					return
				}
				this.replayRecoveryInProgress = true
				this.replayRecoveryAttempts += 1
				const sessionId = this.inlineReplaySessionId
				try {
					const status = await callBackend('/api/replay-sessions/' + encodeURIComponent(sessionId) + '/status')
					if (this.viewerMode !== 'replay' || sessionId !== this.inlineReplaySessionId) return
					if (status && status.state === 'recovering') {
						this.scheduleReplayRecovery(REPLAY_RECOVERY_POLL_MS)
						return
					}
					if (status && status.state === 'ready' && status.playUrl && status.playUrl !== this.liveUrl) {
						this.replayBaseSec = Number(status.currentSec) || this.replayBaseSec
						this.replayMediaTime = 0
						this.liveUrl = status.playUrl
						this.$nextTick(() => this.videoContext && this.videoContext.play && this.videoContext.play())
						return
					}
					const targetSec = Math.max(0, this.replayBaseSec + this.replayMediaTime)
					const refreshed = await callBackend('/api/replay-sessions/' + encodeURIComponent(sessionId) + '/seek', {
						method: 'POST',
						data: { targetSec }
					})
					if (this.viewerMode !== 'replay' || sessionId !== this.inlineReplaySessionId) return
					this.replayBaseSec = Number(refreshed.currentSec) || targetSec
					this.replayMediaTime = 0
					this.liveUrl = refreshed.playUrl || refreshed.streamUrl || this.liveUrl
					this.$nextTick(() => this.videoContext && this.videoContext.play && this.videoContext.play())
				} catch (error) {
					console.log('[live] replay recovery failed', {
						attempt: this.replayRecoveryAttempts,
						code: error && (error.code || error.message)
					})
					if (this.replayRecoveryAttempts >= REPLAY_RECOVERY_MAX_ATTEMPTS) {
						this.failPlayback('replay', '录像播放中断，请重试')
					} else {
						this.scheduleReplayRecovery(REPLAY_RECOVERY_POLL_MS)
					}
				} finally {
					this.replayRecoveryInProgress = false
				}
			},
			async closeInlineReplaySession() {
				this.clearReplayRecovery()
				const sessionIds = [...new Set([
					this.inlineReplaySessionId,
					this.inlineReplayManifestSessionId
				].filter(Boolean))]
				this.inlineReplaySessionId = ''
				this.inlineReplayManifestSessionId = ''
				for (const sessionId of sessionIds) {
					try {
						await callBackend('/api/replay-sessions/' + encodeURIComponent(sessionId), { method: 'DELETE' })
					} catch (error) {
						console.log('[live] close inline replay failed', error)
					}
				}
			},
			async playInlineRecord(item) {
				if (!item || this.replayLoading) return
				if (this.isRecordingBusy || this.isTalkActive) {
					uni.showToast({ title: '请先结束录制或通话', icon: 'none' })
					return
				}
				const nextReplayKey = item.recordingKey || String(item.beginTime || item.BeginTime || '')
				if (
					this.viewerMode === 'replay' &&
					this.inlineReplayKey === nextReplayKey &&
					this.liveUrl &&
					this.playState !== 'error'
				) return
				this.replayLoading = true
				this.replaySourceSwitching = true
				if (this.replaySourceSwitchTimer) clearTimeout(this.replaySourceSwitchTimer)
				this.replaySourceSwitchTimer = null
				this.clearReplayTransientError()
				if (typeof this.teardownLiveMedia === 'function') this.teardownLiveMedia({ finalizeRecording: true })
				if (this.videoContext && this.videoContext.pause) this.videoContext.pause()
				this.liveUrl = ''
				if (this.viewerMode === 'live') await this.stopLiveForInlineReplay()
				else await this.closeInlineReplaySession()
				this.rotateVideoPlayer()
				this.viewerMode = 'replay'
				this.replayFullscreen = false
				this.clearReplayControlsTimer()
				this.cancelReplayProgressGesture()
				this.replayHasStarted = false
				this.replayTransport = ''
				this.replayClipStartSec = null
				this.inlineReplayRecord = item
				this.inlineReplayKey = nextReplayKey
				this.replayMediaTime = 0
				this.replayDurationSec = Math.max(0, Number(item.durationSec || item.duration || 0))
				this.replayPendingSeekSec = 0
				this.replayProgressBeforeDragSec = 0
				this.replayLastProgressAt = 0
				this.replayRecoveryAttempts = 0
				this.clearReplayRecovery()
				this.setPlaybackState('requestingReplay', '正在加载录像...')
				try {
					const result = await callBackend('/api/devices/' + encodeURIComponent(this.device.sn) + '/playback-url', {
						method: 'POST',
						data: {
							channel: 0,
							streamType: 0,
							mediaType: 'hls',
							protocol: 'hls',
							preferDirectHls: true,
							startTime: item.beginTime || item.BeginTime,
							endTime: item.endTime || item.EndTime,
							fileName: item.fileName || item.FileName,
							durationSec: item.durationSec,
							targetSec: 0
						}
					})
					this.inlineReplaySessionId = result.sessionId || ''
					this.inlineReplayManifestSessionId = result.manifestSessionId || ''
					this.replayTransport = result.transport || (this.inlineReplaySessionId ? 'relay' : 'direct-hls')
					this.replayBaseSec = Number(result.currentSec) || 0
					this.liveUrl = result.playUrl || result.url || result.streamUrl || ''
					if (!this.liveUrl) throw new Error('回放地址为空')
					this.statusText = ''
					this.armReplaySourceSwitchTimeout()
					this.refreshVideoContext(() => {
						this.applyReplayPlaybackRate()
						this.videoContext && this.videoContext.play && this.videoContext.play()
					})
				} catch (error) {
					this.completeReplaySourceSwitch()
					this.failPlayback('requestingReplay', getBackendErrorMessage(error, '录像播放失败'))
				} finally {
					this.replayLoading = false
				}
			},
			async returnToLive() {
				await this.closeInlineReplaySession()
				this.rotateVideoPlayer()
				this.viewerMode = 'live'
				this.replayFullscreen = false
				this.clearReplayControlsTimer()
				this.replayHasStarted = false
				this.replayTransport = ''
				this.inlineReplayRecord = null
				this.inlineReplayKey = ''
				this.liveUrl = ''
				this.playState = 'idle'
				this.runPlaybackFlow('return-from-inline-replay')
			},
			async toggleQuality() {
				if (this.playState === 'switchingQuality') return
				if (this.isRecordingBusy) {
					uni.showToast({ title: '录制期间不能切换画质', icon: 'none' })
					return
				}
				const previousQuality = this.quality
				const previousUrl = this.liveUrl
				const previousPayload = this.currentStreamPayload
				const nextQuality = previousQuality === '0' ? '1' : '0'
				this.quality = nextQuality
				this.setPlaybackState('switchingQuality', '正在切换画质...')
				const ok = await this.runPlaybackFlow('quality-switch', {
					preserveUrl: true,
					keepPreviousOnFailure: true
				})
				if (!ok) {
					this.quality = previousQuality
					this.liveUrl = previousUrl
					this.currentStreamPayload = previousPayload
					if (previousUrl) this.setPlaybackState('playing', '')
					else this.failPlayback('switchingQuality', '切换失败，请重试')
					uni.showToast({ title: '切换失败，已恢复原画质', icon: 'none' })
					return
				}
				await this.closeCurrentStream({ payload: previousPayload, clearUrl: false })
			},
			async fallbackToSdkAfterVideoError(error) {
				const failedPayload = this.currentStreamPayload
				if (this.attemptedPlaybackRoutes.has('sdk')) return false
				if (!shouldFallbackToSdkLive({
					source: failedPayload && failedPayload.source,
					deviceToken: this.device && this.device.token,
					attempted: this.sdkFallbackAttempted
				})) return false

				this.sdkFallbackAttempted = true
				this.attemptedPlaybackRoutes.add('sdk')
				this.sdkFallbackInProgress = true
				const requestId = this.activeRequestId + 1
				this.activeRequestId = requestId
				this.liveUrl = ''
				this.setPlaybackState('requestingFallbackStream', '当前线路不兼容，正在切换备用线路...')
				console.log('[live] backend media failed, trying SDK fallback', {
					errMsg: error && error.detail && error.detail.errMsg
				})
				await this.closeCurrentStream({ payload: failedPayload, clearUrl: false })
				if (!this.isActiveRequest(requestId)) return false

				const loggedIn = await this.loginDevice(requestId, { silent: true })
				if (!loggedIn || !this.isActiveRequest(requestId)) {
					this.sdkFallbackInProgress = false
					if (this.isActiveRequest(requestId)) this.failPlayback('deviceLogin', '备用线路连接失败，请重试')
					return false
				}
				const stream = await this.requestLiveUrl(requestId)
				if (!this.isActiveRequest(requestId)) return false
				if (!stream.ok) {
					this.sdkFallbackInProgress = false
					this.failPlayback('requestingFallbackStream', '备用线路连接失败，请重试')
					return false
				}
				this.currentStreamPayload = stream.payload
				this.sdkFallbackInProgress = false
				this.lastVideoProgressAt = Date.now()
				this.liveUrl = stream.url
				this.statusText = '正在加载备用线路...'
				return true
			},
			async fallbackToBackendAfterVideoError(error) {
				const failedPayload = this.currentStreamPayload
				if (!failedPayload || failedPayload.source !== 'sdk' || this.attemptedPlaybackRoutes.has('backend')) return false
				this.attemptedPlaybackRoutes.add('backend')
				this.sdkFallbackInProgress = true
				const requestId = this.activeRequestId + 1
				this.activeRequestId = requestId
				this.setPlaybackState('requestingBackendStream', '正在连接画面...')
				console.log('[live] SDK media failed, trying stable backend route', {
					errMsg: error && error.detail && error.detail.errMsg
				})
				try {
					const stream = await this.requestBackendLiveUrl(requestId)
					if (!stream.ok || !this.isActiveRequest(requestId)) {
						this.failPlayback('requestingBackendStream', '视频加载失败，请重试')
						return false
					}
					this.currentStreamPayload = stream.payload
					this.liveUrl = stream.url
					this.statusText = '正在加载画面...'
					await this.closeCurrentStream({ payload: failedPayload, clearUrl: false })
					return true
				} finally {
					this.sdkFallbackInProgress = false
				}
			},
			onVideoError(error) {
				if (!this.isCurrentVideoEvent(error)) return
				if (this.viewerMode === 'replay') {
					console.log('[live] replay video error', error && error.detail)
					if (this.replaySourceSwitching) return
					if (this.replaySeekInProgress) return
					if (this.inlineReplaySessionId) this.scheduleReplayRecovery(0)
					else if (this.replayHasStarted && this.liveUrl) {
						const progressAtError = this.replayLastProgressAt
						this.clearReplayTransientError()
						this.replayTransientErrorTimer = setTimeout(() => {
							this.replayTransientErrorTimer = null
							if (this.replayLastProgressAt > progressAtError) return
							this.failPlayback('replay-direct-hls', '录像播放中断，请重试')
						}, 2500)
					} else this.failPlayback('replay-direct-hls', '录像播放中断，请重试')
					return
				}
				console.log('[live] onVideoError', {
					source: this.currentStreamPayload && this.currentStreamPayload.source,
					errMsg: error && error.detail && error.detail.errMsg
				})
				this.reportLivePlaybackEvent('video_error', {
					source: 'player',
					errorCode: extractLivePlaybackErrorCode({ error: error && (error.detail || error) })
				})
				if (this.playState === 'switchingQuality') return
				if (this.sdkFallbackInProgress) return
				if (this.currentStreamPayload && this.currentStreamPayload.source === 'sdk' && !this.attemptedPlaybackRoutes.has('backend')) {
					this.fallbackToBackendAfterVideoError(error)
					return
				}
				if (shouldFallbackToSdkLive({
					source: this.currentStreamPayload && this.currentStreamPayload.source,
					deviceToken: this.device && this.device.token,
					attempted: this.sdkFallbackAttempted || this.attemptedPlaybackRoutes.has('sdk')
				})) {
					this.fallbackToSdkAfterVideoError(error)
					return
				}
				this.failPlayback('playing', '视频加载失败，请重试')
			},
			onVideoPlay() {
				const event = arguments[0]
				if (!this.isCurrentVideoEvent(event)) return
				if (this.viewerMode === 'replay') {
					this.completeReplaySourceSwitch()
					this.replayHasStarted = true
					this.replayLastProgressAt = Date.now()
					this.setPlaybackState('playing', '')
					this.applyReplayPlaybackRate()
					this.scheduleReplayControlsHide()
					return
				}
				this.reportLivePlaybackEvent('video_play', { source: 'player' })
				this.lastVideoProgressAt = Date.now()
				this.startPlaybackHealth()
				// The mini-program video component can already render a live frame before
				// HLS media time advances. A real play event is enough to remove the visual
				// loading mask; stall recovery continues to rely on the health tracker.
				this.setPlaybackState('playing', '')
				this.startLiveClock()
				this.clearFirstFrameTimer()
				this.clearCoverCaptureTimer()
				this.firstFrameTimer = setTimeout(() => {
					this.firstFrameTimer = null
					this.warmupLiveRecording()
				}, FIRST_FRAME_READY_DELAY_MS)
				this.coverCaptureTimer = setTimeout(() => {
					this.coverCaptureTimer = null
					this.captureDeviceCoverOnce()
				}, COVER_CAPTURE_DELAY_MS)
			},
			onVideoWaiting() {
				const event = arguments[0]
				if (!this.isCurrentVideoEvent(event)) return
				if (this.viewerMode === 'replay') {
					// Direct vendor HLS can briefly buffer while extending its playlist. Do not
					// rebuild or restart a healthy direct stream; relay recovery only applies to
					// the legacy server-remux session identified by sessionId.
					if (this.inlineReplaySessionId) this.scheduleReplayRecovery(REPLAY_STALL_RECOVERY_MS)
					return
				}
				const health = this.playbackHealthTracker.onWaiting(Date.now())
				console.log('[live] video waiting', {
					landscape: this.isLandscapeFullscreen,
					source: this.currentStreamPayload && this.currentStreamPayload.source,
					lastProgressAgoMs: health.lastAdvanceAgoMs,
					activeStallMs: health.activeStallMs,
					waitingEvents: health.waitingEvents
				})
			},
			onVideoEnded() {
				const event = arguments[0]
				if (!this.isCurrentVideoEvent(event)) return
				if (this.viewerMode !== 'replay') return
				if (this.replayClipStartSec !== null && !this.replayClipExporting) {
					this.finishReplayClipRecording(this.replayMediaTime)
				}
			},
			async resolveSharedLiveToken(requestId) {
				if (!this.device || this.device.role !== 'member') return true
				const existingToken = String(this.device.token || this.device.deviceToken || '').trim()
				if (existingToken && Number(this.device.sharedAccessExpiresAt) > Date.now()) return true
				this.setPlaybackState('checkingSharedAccess', '正在连接画面...')
				let payload
				try {
					payload = await ensureSharedLiveAccess({ device: this.device, callBackend })
				} catch (cause) {
					this.reportLivePlaybackEvent('shared_access_failed', {
						source: 'backend',
						errorCode: extractLivePlaybackErrorCode({ error: cause })
					})
					const error = new Error('暂时无法确认共享权限，请稍后重试')
					error.code = 'SHARED_LIVE_ACCESS_CHECK_FAILED'
					error.cause = cause
					throw error
				}
				if (!this.isActiveRequest(requestId)) return false
				const token = String(payload && payload.deviceToken || '').trim()
				if (!token) {
					this.reportLivePlaybackEvent('shared_access_failed', {
						source: 'backend',
						errorCode: 'SHARED_DEVICE_TOKEN_UNAVAILABLE'
					})
					const error = new Error('共享设备连接凭证暂不可用，请稍后重试')
					error.code = 'SHARED_DEVICE_TOKEN_UNAVAILABLE'
					throw error
				}
				this.device = Object.assign({}, this.device, {
					token,
					deviceToken: token,
					sharedAccessExpiresAt: Number(payload.expiresAt) || 0
				})
				this.reportLivePlaybackEvent('shared_access_granted', { source: 'backend' })
				console.log('[live] shared device token ready', { sn: this.device.sn, source: payload.source || 'cache' })
				return true
			},
			onVideoTimeUpdate(event) {
				if (!this.isCurrentVideoEvent(event)) return
				const detail = (event && event.detail) || {}
				if (this.viewerMode === 'replay') {
					const nextTime = Math.max(0, Number(detail.currentTime) || 0)
					if (nextTime > 0) this.completeReplaySourceSwitch()
					if (!this.replayHasStarted) this.replayHasStarted = true
					if (nextTime > this.replayMediaTime + 0.05) {
						this.clearReplayTransientError()
						this.replayMediaTime = nextTime
						this.replayLastProgressAt = Date.now()
						this.replayRecoveryAttempts = 0
						this.clearReplayRecovery()
						if (this.playState !== 'playing') this.setPlaybackState('playing', '')
					}
					return
				}
				this.postLivePlaybackEvent(this.livePlaybackDiagnostics.progress(detail.currentTime))
				const progress = this.playbackHealthTracker.onProgress({
					nowMs: Date.now(),
					mediaTimeSec: detail.currentTime
				})
				if (progress.advanced) {
					this.lastVideoProgressAt = Date.now()
					if (this.playState !== 'playing') this.setPlaybackState('playing', '')
					const healthyRoute = this.currentStreamPayload && this.currentStreamPayload.source
					if (Number(detail.currentTime) >= 0.5 && ['sdk', 'backend'].includes(healthyRoute)) {
						markHealthyRoute(this.device.sn, healthyRoute, uni)
					}
					if (this.device._statusState !== 'online') {
						this.device = markDevicePlaybackOnline(this.device)
						upsertOwnedDevice(this.device, uni)
					}
				}
				if (progress.recovered) {
					console.log('[live] playback recovered', {
						source: this.currentStreamPayload && this.currentStreamPayload.source,
						stallDurationMs: progress.stallDurationMs,
						mediaTimeSec: progress.mediaTimeSec,
						totalStallMs: progress.totalStallMs
					})
				}
			}
		}
	}
</script>

<style lang="scss" scoped>
	.live-page { height: 100vh; min-height: 0; overflow: hidden; box-sizing: border-box; background: #FBFBFA; color: #141414; display: flex; flex-direction: column; }
	.video-area { width: 100%; height: 460rpx; position: relative; overflow: hidden; background: #000000; flex-shrink: 0;
		.video-player { width: 100%; height: 100%; }
		.video-mask { position: absolute; inset: 0; background: rgba(0,0,0,.46); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 48rpx; }
		.mask-text { color: #FFFFFF; font-size: 28rpx; text-align: center; line-height: 1.5; }
		.mask-actions { margin-top: 24rpx; }
		.retry-btn { height: 68rpx; padding: 0 34rpx; border: 2rpx solid rgba(255,255,255,.28); border-radius: 34rpx; background: rgba(255,255,255,.14); display: flex; align-items: center; }
		.retry-btn-text { color: #FFFFFF; font-size: 26rpx; font-weight: 600; }
	}
	.video-area.is-replay-portrait-fullscreen {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 900;
		width: 100vw;
		height: 100vh;
		background: #000000;
	}
	.video-player.is-replay-portrait-video {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 100vh;
		height: 100vw;
		transform: translate(-50%, -50%) rotate(90deg);
		transform-origin: 50% 50%;
		background: #000000;
	}
	.landscape-controls {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		left: 0;
		width: 100%;
		height: 100%;
		z-index: 20;
		color: #FFFFFF;
		font-size: 14px;
		pointer-events: none;
	}
	.landscape-top-left,
	.landscape-top-right,
	.landscape-sound-control,
	.landscape-center-controls {
		position: absolute;
		z-index: 21;
		pointer-events: auto;
	}
	.landscape-top-left {
		top: 14px;
		left: 18px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.landscape-top-right {
		top: 14px;
		right: 18px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.landscape-round-button {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: rgba(22, 25, 24, .64);
		border: 1px solid rgba(255, 255, 255, .16);
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
	}
	.landscape-round-button.is-active {
		background: rgba(47, 163, 92, .82);
		border-color: rgba(255, 255, 255, .34);
	}
	.more-button {
		font-size: 15px;
		font-weight: 700;
		line-height: 34px;
		text-align: center;
		letter-spacing: 1px;
	}
	.icon-chevron {
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.icon-chevron-line {
		width: 10px;
		height: 10px;
		border-left: 2px solid #FFFFFF;
		border-bottom: 2px solid #FFFFFF;
		transform: rotate(45deg);
		margin-left: 5px;
	}
	.live-status-pill {
		height: 34px;
		max-width: 230px;
		padding: 0 12px;
		border-radius: 17px;
		background: rgba(22, 25, 24, .58);
		border: 1px solid rgba(255, 255, 255, .13);
		display: flex;
		align-items: center;
		box-sizing: border-box;
	}
	.live-status-dot {
		width: 8px;
		height: 8px;
		margin-right: 9px;
		border-radius: 50%;
		background: #3DDC74;
		flex-shrink: 0;
	}
	.live-status-copy {
		max-width: 198px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-size: 11px;
		line-height: 34px;
		color: #FFFFFF;
	}
	.quality-pill {
		height: 34px;
		min-width: 54px;
		padding: 0 13px;
		border-radius: 17px;
		background: rgba(22, 25, 24, .58);
		border: 1px solid rgba(255, 255, 255, .13);
		box-sizing: border-box;
		font-size: 11px;
		font-weight: 600;
		line-height: 34px;
		text-align: center;
	}
	.landscape-sound-control {
		left: 22px;
		bottom: 22px;
		width: 50px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.landscape-center-controls {
		left: 50%;
		bottom: 18px;
		transform: translateX(-50%);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 36px;
	}
	.landscape-action {
		width: 58px;
		min-height: 70px;
		display: flex;
		flex-direction: column;
		align-items: center;
	}
	.landscape-control-label {
		width: 58px;
		margin-top: 6px;
		color: #FFFFFF;
		font-size: 11px;
		line-height: 16px;
		text-align: center;
		text-shadow: 0 1px 3px rgba(0, 0, 0, .48);
	}
	.record-button {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: rgba(255, 255, 255, .94);
		border: 1px solid rgba(255, 255, 255, .6);
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
	}
	.record-dot {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: #E8734A;
	}
	.record-button.is-recording .record-dot {
		width: 14px;
		height: 14px;
		border-radius: 4px;
	}
	.record-button.is-pending {
		opacity: .72;
	}
	.record-elapsed {
		width: 58px;
		color: #FFFFFF;
		font-size: 10px;
		line-height: 13px;
		text-align: center;
		text-shadow: 0 1px 3px rgba(0, 0, 0, .48);
	}
	.mic-glyph {
		width: 24px;
		height: 25px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}
	.camera-glyph {
		position: relative;
		width: 24px;
		height: 18px;
		border: 2px solid #FFFFFF;
		border-radius: 4px;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.recording-button {
		background: rgba(255, 255, 255, .92);
	}
	.recording-button.is-recording {
		background: rgba(255, 255, 255, .96);
	}
	.record-glyph {
		width: 17px;
		height: 17px;
		border-radius: 50%;
		background: #E8734A;
	}
	.record-glyph.is-stopping {
		width: 14px;
		height: 14px;
		border-radius: 4px;
	}
	.camera-glyph::before {
		content: '';
		position: absolute;
		top: -5px;
		left: 6px;
		width: 8px;
		height: 4px;
		border-radius: 2px 2px 0 0;
		background: #FFFFFF;
	}
	.camera-lens {
		width: 7px;
		height: 7px;
		border: 2px solid #FFFFFF;
		border-radius: 50%;
		box-sizing: border-box;
	}
	.mic-head {
		width: 9px;
		height: 15px;
		border: 2px solid #FFFFFF;
		border-radius: 7px;
		box-sizing: border-box;
	}
	.mic-stem {
		width: 16px;
		height: 9px;
		margin-top: -5px;
		border-left: 2px solid #FFFFFF;
		border-right: 2px solid #FFFFFF;
		border-bottom: 2px solid #FFFFFF;
		border-radius: 0 0 9px 9px;
		box-sizing: border-box;
	}
	.sound-glyph {
		position: relative;
		width: 25px;
		height: 24px;
	}
	.sound-body {
		position: absolute;
		left: 2px;
		top: 8px;
		width: 7px;
		height: 8px;
		background: #FFFFFF;
		border-radius: 2px 0 0 2px;
		box-sizing: border-box;
	}
	.sound-cone {
		position: absolute;
		left: 8px;
		top: 5px;
		width: 0;
		height: 0;
		border-top: 7px solid transparent;
		border-bottom: 7px solid transparent;
		border-right: 0;
		border-left: 8px solid #FFFFFF;
	}
	.sound-wave {
		position: absolute;
		border-right: 2px solid #FFFFFF;
		border-radius: 50%;
	}
	.sound-wave-inner {
		right: 5px;
		top: 7px;
		width: 5px;
		height: 10px;
	}
	.sound-wave-outer {
		right: 0;
		top: 4px;
		width: 10px;
		height: 16px;
	}
	.sound-slash {
		position: absolute;
		left: 2px;
		top: 11px;
		width: 23px;
		height: 2px;
		background: #FFFFFF;
		transform: rotate(45deg);
	}
	.action-bar { display: flex; gap: 16rpx; padding: 28rpx 48rpx; background: #FBFBFA; border-bottom: 2rpx solid #E8E8E5;
		.action-btn { flex: 1; min-width: 0; height: 112rpx; padding: 0 24rpx; box-sizing: border-box; display: flex; align-items: center; background: #F1F1EF; border-radius: 56rpx; }
		.action-btn.is-active { background: #EFEEEC; }
		.action-icon { width: 58rpx; height: 58rpx; flex-shrink: 0; border-radius: 50%; background: #FFFFFF; color: #141414; display: flex; align-items: center; justify-content: center; font-size: 27rpx; font-weight: 700; }
		.action-copy { min-width: 0; display: flex; flex-direction: column; margin-left: 16rpx; }
		.action-label { font-size: 28rpx; color: #141414; font-weight: 600; line-height: 1.35; }
		.action-hint { font-size: 22rpx; color: #989893; margin-top: 4rpx; line-height: 1.35; }
	}
	.replay-fullscreen-controls { position: absolute; top: 0; right: 0; bottom: 0; left: 0; width: 100%; height: 100%; z-index: 903; color: #FFFFFF; font-size: 14px; pointer-events: none; }
	.replay-fullscreen-tap-layer { position: absolute; top: 0; right: 0; bottom: 0; left: 0; z-index: 902; background: transparent; pointer-events: auto; }
	.replay-fullscreen-controls .landscape-top-left,
	.replay-fullscreen-controls .landscape-sound-control,
	.replay-fullscreen-controls .landscape-center-controls,
	.replay-fullscreen-controls .replay-speed-overlay { pointer-events: auto; }
	.replay-status-dot { width: 8px; height: 8px; margin-right: 9px; border-radius: 50%; background: #E8734A; flex-shrink: 0; }
	.replay-center-controls { gap: 0; }
	.replay-speed-bar { min-height: 78rpx; padding: 12rpx 48rpx 20rpx; display: flex; align-items: center; justify-content: space-between; gap: 24rpx; background: #FBFBFA; border-bottom: 2rpx solid #E8E8E5; box-sizing: border-box; }
	.replay-speed-label { color: #989893; font-size: 22rpx; white-space: nowrap; }
	.replay-speed-options { display: flex; align-items: center; gap: 10rpx; }
	.replay-speed-chip { min-width: 76rpx; height: 50rpx; padding: 0 14rpx; border-radius: 25rpx; color: #5A5A56; background: #F1F1EF; font-size: 22rpx; line-height: 50rpx; text-align: center; box-sizing: border-box; }
	.replay-speed-chip.is-active { color: #FFFFFF; font-weight: 700; background: #141414; }
	.replay-speed-overlay { position: absolute; right: 18px; z-index: 28; display: flex; align-items: center; gap: 5px; padding: 4px; border-radius: 999px; background: rgba(20, 20, 20, .68); pointer-events: auto; }
	.replay-speed-option { min-width: 36px; height: 28px; padding: 0 6px; border-radius: 999px; color: rgba(255,255,255,.74); font-size: 11px; line-height: 28px; text-align: center; box-sizing: border-box; }
	.replay-speed-option.is-active { color: #141414; font-weight: 700; background: #FFFFFF; }
	.replay-fullscreen-entry { flex: none; min-width: 86rpx; height: 50rpx; padding: 0 12rpx; border-radius: 25rpx; background: #141414; color: #FFFFFF; font-size: 21rpx; line-height: 50rpx; text-align: center; }
	.replay-progress-shell { position: absolute; left: 18px; right: 18px; z-index: 30; height: 28px; display: flex; align-items: center; gap: 9px; pointer-events: auto; }
	.replay-progress-time { width: 42px; color: #FFFFFF; font-size: 10px; line-height: 20px; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,.7); }
	.replay-progress-track { position: relative; flex: 1; height: 20px; display: flex; align-items: center; }
	.replay-progress-track::before { content: ''; position: absolute; left: 0; right: 0; top: 8px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.34); }
	.replay-progress-fill { position: absolute; left: 0; top: 8px; height: 4px; border-radius: 2px; background: #FFFFFF; }
	.replay-progress-thumb { position: absolute; top: 4px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: #FFFFFF; }
	.replay-marker-range { position: absolute; top: 8px; height: 4px; min-width: 2px; z-index: 2; }
	.replay-marker-range.is-cat, .replay-marker-range.is-face { background: #2FA35C; }
	.replay-marker-range.is-feeding { background: #E8734A; }
	.replay-fullscreen-controls .landscape-top-left { left: 18px; }
	.replay-fullscreen-controls .landscape-sound-control { left: 22px; }
	.replay-fullscreen-controls .replay-center-controls { left: 50%; transform: translateX(-50%); }
	.alert-panel { flex: 1; min-height: 0; overflow: hidden; padding: 34rpx 48rpx 0; background: #FBFBFA; display: flex; flex-direction: column; }
	.alert-list { flex: 1; min-height: 0; height: 0; margin-top: 28rpx; padding-bottom: calc(36rpx + env(safe-area-inset-bottom)); box-sizing: border-box; }
	.alert-card { min-height: 142rpx; margin-bottom: 16rpx; padding: 14rpx; border: 2rpx solid #E8E8E5; border-radius: 28rpx; background: #FFFFFF; display: flex; align-items: center; gap: 20rpx; box-sizing: border-box; }
	.alert-image { width: 176rpx; height: 112rpx; flex: none; border-radius: 20rpx; background: #F1F1EF; }
	.alert-image-placeholder { display: flex; align-items: center; justify-content: center; color: #989893; font-size: 28rpx; }
	.alert-copy { flex: 1; min-width: 0; }
	.alert-title { display: block; color: #141414; font-size: 28rpx; font-weight: 650; }
	.alert-time { display: block; margin-top: 10rpx; color: #989893; font-size: 22rpx; }
	.inline-replay { flex: 1; min-height: 0; overflow: hidden; padding: 34rpx 48rpx 0; background: #FBFBFA; border-top: 2rpx solid #E8E8E5; display: flex; flex-direction: column; }
	.replay-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20rpx; }
	.replay-title { display: block; font-size: 34rpx; line-height: 1.25; font-weight: 700; }
	.replay-subtitle { display: block; margin-top: 8rpx; color: #989893; font-size: 22rpx; }
	.date-pill { min-height: 58rpx; padding: 0 22rpx; border-radius: 29rpx; background: #F1F1EF; display: flex; align-items: center; color: #141414; font-size: 22rpx; }
	.replay-loading, .replay-empty { flex: 1; min-height: 180rpx; display: flex; align-items: center; justify-content: center; color: #989893; font-size: 24rpx; }
	.inline-record-list { flex: 1; min-height: 0; height: 0; margin-top: 28rpx; box-sizing: border-box; padding-bottom: calc(36rpx + env(safe-area-inset-bottom)); }
	.timeline-list-layout { position: relative; min-height: 100%; padding-bottom: 16rpx; }
	.day-timeline-band { position: absolute; top: 10rpx; bottom: 26rpx; left: 8rpx; width: 18rpx; overflow: hidden; border-radius: 9rpx; background: #C4C4C0; }
	.day-timeline-segment { position: absolute; left: 0; width: 100%; min-height: 7rpx; z-index: 1; }
	.day-timeline-segment.is-cat { background: #2FA35C; }
	.day-timeline-segment.is-feeding { z-index: 2; background: #E8734A; }
	.timeline-record-row { position: relative; display: flex; align-items: stretch; gap: 14rpx; min-height: 158rpx; }
	.timeline-time-cell { width: 106rpx; flex: none; padding-left: 34rpx; display: flex; align-items: center; justify-content: flex-start; box-sizing: border-box; }
	.timeline-time { color: #5A5A56; font-size: 19rpx; line-height: 28rpx; white-space: nowrap; }
	.inline-record-card { flex: 1; min-width: 0; min-height: 142rpx; margin-bottom: 16rpx; padding: 14rpx; border: 2rpx solid #E8E8E5; border-radius: 28rpx; background: #FFFFFF; display: flex; align-items: center; gap: 20rpx; }
	.inline-record-card.is-selected { border-color: #141414; }
	.record-cover { width: 176rpx; height: 112rpx; flex: none; border-radius: 20rpx; background: #F1F1EF; }
	.record-cover-placeholder { display: flex; align-items: center; justify-content: center; color: #989893; font-size: 34rpx; }
	.record-copy { flex: 1; min-width: 0; }
	.record-title { display: block; color: #141414; font-size: 29rpx; font-weight: 600; }
	.record-meta { display: block; margin-top: 10rpx; color: #989893; font-size: 22rpx; }
	.record-arrow { color: #C4C4C0; font-size: 38rpx; }
</style>
