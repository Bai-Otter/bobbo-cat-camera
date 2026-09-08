<template>
	<view class="tab-shell">
		<view class="tab-bar">
			<view
				class="tab-item"
				v-for="item in tabs"
				:key="item.key"
				:class="{active: current === item.key}"
				@click="switchPage(item)"
			>
				<view class="tab-icon-wrap">
					<cat-icon
						:name="current === item.key && item.activeIcon ? item.activeIcon : item.icon"
						:size="52"
						:color="current === item.key ? '#141414' : '#8B8B88'"
						:stroke="1.7"
					/>
				</view>
				<text class="tab-label">{{item.label}}</text>
			</view>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'

	export default {
		name: 'app-tab-bar',
		components: { catIcon },
		props: {
			current: { type: String, required: true }
		},
		data() {
			return {
				tabs: [
					{ key: 'today', label: '今日', icon: 'home', activeIcon: 'home-solid', url: '/pages/today/index' },
					{ key: 'live', label: '实时', icon: 'video', activeIcon: 'video-solid', url: '/pages/live/overview' },
					{ key: 'foodcast', label: '吃播', icon: 'foodcast', activeIcon: 'foodcast-solid', url: '/pages/clips/index' },
					{ key: 'profile', label: '我的', icon: 'profile', activeIcon: 'profile-solid', url: '/pages/profile/index' }
				]
			}
		},
		methods: {
			switchPage(item) {
				if (!item || item.key === this.current) return
				uni.reLaunch({ url: item.url })
			}
		}
	}
</script>

<style>
	.tab-shell {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 100;
		padding: 0 0 env(safe-area-inset-bottom);
		background: rgba(251,251,250,.62);
		-webkit-backdrop-filter: blur(22px) saturate(1.8);
		backdrop-filter: blur(22px) saturate(1.8);
		border-top: 2rpx solid rgba(0,0,0,.06);
		pointer-events: none;
	}
	.tab-bar {
		height: 108rpx;
		padding: 16rpx 0 4rpx;
		box-sizing: border-box;
		background: transparent;
		display: flex;
		align-items: stretch;
		pointer-events: auto;
	}
	.tab-item {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		color: #8B8B88;
	}
	.tab-item.active { color: #141414; }
	.tab-icon-wrap {
		width: 52rpx;
		height: 52rpx;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.tab-label { margin-top: 8rpx; font-size: 21rpx; line-height: 1; letter-spacing: 0; color: inherit; font-weight: 600; }
</style>
