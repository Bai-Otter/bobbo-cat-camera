<template>
	<view class="bobbo-nav">
		<view class="bobbo-nav-status" :style="{ height: statusBarHeight + 'px' }"></view>
		<view
			class="bobbo-nav-row"
			:style="{ height: navHeight + 'px' }"
		>
			<view class="bobbo-nav-side bobbo-nav-side-left">
				<view class="bobbo-nav-back" role="button" aria-label="返回" @click="handleBack">
					<text class="bobbo-nav-back-icon">‹</text>
				</view>
			</view>
			<view
				class="bobbo-nav-title"
				:class="{ 'bobbo-nav-title-left': titleAlign === 'left' }"
				:style="titleStyle"
			>
				<text class="bobbo-nav-title-text">{{ normalizedTitle }}</text>
			</view>
			<view class="bobbo-nav-side bobbo-nav-side-right" :style="{ right: rightReserve + 'px' }">
				<slot name="right"></slot>
			</view>
		</view>
	</view>
</template>

<script>
	export default {
		name: 'bobbo-nav-bar',
		props: {
			title: { type: String, default: '' },
			titleAlign: { type: String, default: 'center' },
			backHandler: { type: Function, default: null }
		},
		data() {
			return {
				statusBarHeight: 24,
				navHeight: 44,
				rightReserve: 12
			}
		},
		created() {
			this.setNavigationMetrics()
		},
		computed: {
			normalizedTitle() {
				return this.title == null ? '' : String(this.title)
			},
			titleReserve() {
				return Math.max(56, (Number(this.rightReserve) || 12) + 44)
			},
			titleStyle() {
				if (this.titleAlign === 'left') {
					return { right: this.titleReserve + 'px' }
				}
				return { left: this.titleReserve + 'px', right: this.titleReserve + 'px' }
			}
		},
		methods: {
			handleBack() {
				if (this.backHandler) {
					this.backHandler()
					return
				}
				this.goBack()
			},
			setNavigationMetrics() {
				const runtime = typeof uni !== 'undefined' ? uni : null
				let systemInfo = {}
				try {
					if (runtime && typeof runtime.getSystemInfoSync === 'function') {
						systemInfo = runtime.getSystemInfoSync() || {}
					} else if (typeof wx !== 'undefined' && typeof wx.getWindowInfo === 'function') {
						systemInfo = wx.getWindowInfo() || {}
					}
				} catch (error) {
					systemInfo = {}
				}

				this.statusBarHeight = Number(systemInfo.statusBarHeight) || 24
				const readMenuButton = runtime && typeof runtime.getMenuButtonBoundingClientRect === 'function'
					? () => runtime.getMenuButtonBoundingClientRect()
					: typeof wx !== 'undefined' && typeof wx.getMenuButtonBoundingClientRect === 'function'
						? () => wx.getMenuButtonBoundingClientRect()
						: null

				if (!readMenuButton) return
				try {
					const menuButton = readMenuButton() || {}
					const windowWidth = Number(systemInfo.windowWidth)
					const menuTop = Number(menuButton.top)
					const menuLeft = Number(menuButton.left)
					const menuHeight = Number(menuButton.height)
					if (!windowWidth || !menuLeft || !menuHeight || !Number.isFinite(menuTop)) return

					const verticalGap = Math.max(0, menuTop - this.statusBarHeight)
					this.navHeight = Math.max(44, verticalGap * 2 + menuHeight)
					this.rightReserve = Math.max(12, windowWidth - menuLeft + 8)
				} catch (error) {
					this.navHeight = 44
					this.rightReserve = 12
				}
			},
			goToday() {
				uni.reLaunch({ url: '/pages/today/index' })
			},
			goBack() {
				const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
				if (pages.length > 1) {
					uni.navigateBack({ delta: 1, fail: this.goToday })
					return
				}
				this.goToday()
			}
		}
	}
</script>

<style>
	.bobbo-nav {
		background: #FBFBFA;
		color: #141414;
		border-bottom: 2rpx solid #E8E8E5;
	}
	.bobbo-nav-status { width: 100%; }
	.bobbo-nav-row {
		position: relative;
		box-sizing: border-box;
	}
	.bobbo-nav-side {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 88rpx;
		display: flex;
		align-items: center;
		overflow: hidden;
		z-index: 2;
	}
	.bobbo-nav-side-left { left: 24rpx; justify-content: flex-start; }
	.bobbo-nav-side-right { justify-content: flex-end; }
	.bobbo-nav-back {
		width: 72rpx;
		height: 72rpx;
		display: flex;
		align-items: center;
		justify-content: flex-start;
	}
	.bobbo-nav-back-icon {
		font-size: 64rpx;
		font-weight: 300;
		line-height: 1;
		color: #141414;
	}
	.bobbo-nav-title {
		position: absolute;
		top: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
	}
	.bobbo-nav-title-left { left: 112rpx !important; justify-content: flex-start; }
	.bobbo-nav-title-text {
		max-width: 100%;
		font-size: 32rpx;
		font-weight: 600;
		line-height: 44rpx;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
