<template>
	<view class="launch-page">
		<image
			class="launch-logo"
			src="/static/images/bobbo-logo.png"
			mode="aspectFit"
		/>
	</view>
</template>

<script>
	export default {}
</script>

<style lang="scss" scoped>
	.launch-page {
		width: 100%;
		min-height: 100vh;
		box-sizing: border-box;
		padding: constant(safe-area-inset-top) 48rpx constant(safe-area-inset-bottom);
		padding: env(safe-area-inset-top) 48rpx env(safe-area-inset-bottom);
		background: #FBFBFA;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.launch-logo {
		width: 260rpx;
		height: 76rpx;
		display: block;
	}
</style>
