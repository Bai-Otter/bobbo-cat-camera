<template>
	<view class="preferences-page">
		<bobbo-nav-bar title="吃播偏好" title-align="left" />

		<view class="preferences-content">
			<text class="preferences-intro">所有猫咪共用同一套自动剪辑方式，点击即保存</text>
			<text class="section-label">剪辑节奏</text>

			<view
				class="preference-card"
				:class="{ selected: mode === 'quick_cut' }"
				@click="selectMode('quick_cut')"
			>
				<view class="preference-copy">
					<text class="preference-title">萌脸快剪</text>
					<text class="preference-note">优先保留可爱表情与高光瞬间，节奏更轻快</text>
				</view>
				<view v-if="mode === 'quick_cut'" class="selected-mark"><text>✓</text></view>
			</view>

			<view
				class="preference-card"
				:class="{ selected: mode === 'natural' }"
				@click="selectMode('natural')"
			>
				<view class="preference-copy">
					<text class="preference-title">自然慢剪</text>
					<text class="preference-note">保留更完整的进食过程，节奏更舒缓</text>
				</view>
				<view v-if="mode === 'natural'" class="selected-mark"><text>✓</text></view>
			</view>

			<text class="section-label duration-label">成片时长</text>
			<text class="section-note">自动会按当天餐次和有效画面自然增减，不重复素材凑时长。</text>
			<view class="duration-grid">
				<view
					v-for="option in durationOptions"
					:key="option.value"
					class="duration-option"
					:class="{ selected: durationMode === option.value }"
					@click="selectDurationMode(option.value)"
				>
					<view class="duration-copy">
						<text class="duration-title">{{ option.title }}</text>
						<text class="duration-note">{{ option.note }}</text>
					</view>
					<view v-if="durationMode === option.value" class="selected-mark"><text>✓</text></view>
				</view>
			</view>

			<text class="preferences-footnote">修改只影响以后生成的吃播，已保存的作品不会重新生成。</text>
		</view>
	</view>
</template>

<script>
	const { callBackend, getBackendErrorMessage } = require('../../utils/backendClient.js')
	const FOODCAST_PREFERENCES_KEY = 'bobbo_foodcast_ui_preferences'

	export default {
		name: 'foodcast-preferences',
		data() {
			return {
				mode: 'quick_cut',
				durationMode: 'auto',
				saving: false,
				durationOptions: [
					{ value: 'auto', title: '自动', note: '随素材变化' },
					{ value: 'compact', title: '精简', note: '30 秒内' },
					{ value: 'standard', title: '标准', note: '60 秒内' },
					{ value: 'rich', title: '丰富', note: '120 秒内' }
				]
			}
		},
		onLoad() {
			this.loadPreferences()
		},
		methods: {
			normalizeDurationMode(value) {
				return ['compact', 'standard', 'rich'].includes(value) ? value : 'auto'
			},
			async loadPreferences() {
				let cachedMode = 'quick_cut'
				let cachedDurationMode = 'auto'
				try {
					const preferences = uni.getStorageSync(FOODCAST_PREFERENCES_KEY)
					if (preferences && preferences.mode === 'natural') cachedMode = 'natural'
					if (preferences) cachedDurationMode = this.normalizeDurationMode(preferences.durationMode)
				} catch (error) {}
				this.mode = cachedMode
				this.durationMode = cachedDurationMode
				try {
					const result = await callBackend('/api/foodcasts/preferences')
					this.mode = result && result.preferences && result.preferences.mode === 'natural' ? 'natural' : 'quick_cut'
					this.durationMode = this.normalizeDurationMode(result && result.preferences && result.preferences.durationMode)
					this.cachePreferences()
				} catch (error) {
					console.log('[foodcast-preferences] load failed', error)
				}
			},
			async selectMode(mode) {
				if (this.saving) return
				const next = mode === 'natural' ? 'natural' : 'quick_cut'
				if (next === this.mode) return
				await this.savePreferences({ mode: next })
			},
			async selectDurationMode(value) {
				if (this.saving) return
				const next = this.normalizeDurationMode(value)
				if (next === this.durationMode) return
				await this.savePreferences({ durationMode: next })
			},
			async savePreferences(patch) {
				const previous = { mode: this.mode, durationMode: this.durationMode }
				Object.assign(this, patch)
				this.cachePreferences()
				this.saving = true
				try {
					const result = await callBackend('/api/foodcasts/preferences', {
						method: 'PUT',
						data: { mode: this.mode, durationMode: this.durationMode }
					})
					this.mode = result && result.preferences && result.preferences.mode === 'natural' ? 'natural' : 'quick_cut'
					this.durationMode = this.normalizeDurationMode(result && result.preferences && result.preferences.durationMode)
					this.cachePreferences()
				} catch (error) {
					this.mode = previous.mode
					this.durationMode = previous.durationMode
					this.cachePreferences()
					uni.showToast({ title: getBackendErrorMessage(error, '保存失败，请重试'), icon: 'none' })
				} finally { this.saving = false }
			},
			cachePreferences() {
				let current = {}
				try {
					const stored = uni.getStorageSync(FOODCAST_PREFERENCES_KEY)
					if (stored && typeof stored === 'object') current = stored
				} catch (error) {}
				uni.setStorageSync(FOODCAST_PREFERENCES_KEY, { ...current, mode: this.mode, durationMode: this.durationMode })
			}
		}
	}
</script>

<style>
	.preferences-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.preferences-content { padding: 24rpx 48rpx 48rpx; }
	.preferences-intro { display: block; font-size: 25rpx; line-height: 40rpx; color: #989893; }
	.section-label { display: block; margin-top: 34rpx; font-size: 25rpx; line-height: 36rpx; font-weight: 600; color: #141414; }
	.section-note { display: block; margin-top: 8rpx; font-size: 22rpx; line-height: 34rpx; color: #989893; }
	.preference-card { box-sizing: border-box; min-height: 150rpx; margin-top: 24rpx; padding: 30rpx 32rpx; display: flex; align-items: center; gap: 28rpx; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 36rpx; }
	.preference-card.selected { border: 4rpx solid #141414; padding: 28rpx 30rpx; }
	.preference-copy { flex: 1; min-width: 0; }
	.preference-title { display: block; font-size: 31rpx; line-height: 44rpx; font-weight: 600; color: #141414; }
	.preference-note { display: block; margin-top: 6rpx; font-size: 24rpx; line-height: 38rpx; color: #989893; }
	.selected-mark { width: 48rpx; height: 48rpx; flex: 0 0 48rpx; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: #141414; }
	.selected-mark text { font-size: 25rpx; line-height: 32rpx; font-weight: 700; color: #FFFFFF; }
	.duration-label { margin-top: 48rpx; }
	.duration-grid { margin-top: 20rpx; display: flex; flex-direction: column; gap: 16rpx; }
	.duration-option { box-sizing: border-box; width: 100%; min-height: 112rpx; padding: 22rpx 30rpx; display: flex; align-items: center; gap: 28rpx; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 30rpx; }
	.duration-option.selected { border: 4rpx solid #141414; padding: 20rpx 28rpx; }
	.duration-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; justify-content: center; }
	.duration-title { font-size: 27rpx; line-height: 38rpx; font-weight: 600; color: #141414; }
	.duration-note { margin-top: 3rpx; font-size: 21rpx; line-height: 30rpx; color: #989893; }
	.preferences-footnote { display: block; margin-top: 30rpx; font-size: 22rpx; line-height: 35rpx; color: #B4B4B0; }
</style>
