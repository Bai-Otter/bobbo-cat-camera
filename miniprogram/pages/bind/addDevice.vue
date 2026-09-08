<template>
	<view class="add-page">
		<bobbo-nav-bar title="添加设备" title-align="left"></bobbo-nav-bar>
		<view class="page-content">
		<view class="page-header">
			<text class="page-desc">选择配网或绑定方式</text>
		</view>

		<view class="method-card" v-for="item in methods" :key="item.id" @click="tapMethod(item)">
			<view class="method-icon-wrap">
				<cat-icon :name="item.icon" :size="44" color="#141414" />
			</view>
			<view class="method-content">
				<text class="method-title">{{item.title}}</text>
				<text class="method-desc">{{item.desc}}</text>
			</view>
			<text class="card-arrow">›</text>
		</view>
		</view>
	</view>
</template>

<script>
	import catIcon from '@/components/cat-icon/cat-icon.vue'
	const { ensureAppSession } = require('@/utils/appAuth.js')

	export default {
		components: { catIcon },
		data() {
			return {
				methods: [
					{ id: 'bluetooth', icon: 'wifi', color: 'bg-sky-blue', title: '蓝牙配网', desc: '自动发现附近设备并完成添加' },
					{ id: 'qrcode', icon: 'monitor', color: 'bg-slate-blue', title: '二维码配置', desc: '生成二维码让摄像头扫码配网' },
					{ id: 'manual', icon: 'camera', color: 'bg-deep-blue', title: '手动绑定', desc: '直接输入设备 SN 和设备密码' }
				]
			}
		},
		methods: {
			ensureAppAuth() {
				return !!ensureAppSession({ message: '请先登录' })
			},
			tapMethod(item) {
				if (!this.ensureAppAuth()) return
				const urlMap = {
					bluetooth: '/pages/bind/bluetooth',
					qrcode: '/pages/bind/qrcode',
					manual: '/pages/bind/repairing?type=manual'
				}
				uni.navigateTo({ url: urlMap[item.id] })
			}
		}
	}
</script>

<style>
	.add-page { min-height: 100vh; background: #FBFBFA; color: #141414; }
	.page-content { padding: 32rpx; padding-bottom: calc(40rpx + env(safe-area-inset-bottom)); }
	.page-header { padding: 4rpx 0 28rpx; }
	.page-desc { font-size: 26rpx; color: #989893; }
	.method-card { display: flex; align-items: center; min-height: 112rpx; box-sizing: border-box; background: #FFFFFF; border: 2rpx solid #EDEDEB; border-radius: 16rpx; padding: 26rpx 28rpx; margin-bottom: 20rpx; }
	.method-icon-wrap { width: 72rpx; height: 72rpx; border-radius: 14rpx; background: #F1F1EF; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.method-content { flex: 1; margin-left: 24rpx; }
	.method-title { display: block; font-size: 30rpx; font-weight: 600; color: #141414; margin-bottom: 6rpx; }
	.method-desc { font-size: 24rpx; color: #989893; line-height: 1.45; }
	.card-arrow { font-size: 40rpx; color: #989893; font-weight: 300; }
</style>
