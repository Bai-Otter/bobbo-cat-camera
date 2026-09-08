<template>
	<view class="profile-page">
		<!-- 顶部标题 -->
		<view class="page-header">
			<text class="page-title">我的</text>
		</view>

		<!-- 用户卡片 -->
		<view class="user-card">
			<image class="user-avatar" :src="userAvatar" mode="aspectFill" />
			<view class="user-info">
				<text class="user-name">{{userName}}</text>
				<text class="user-sub">{{deviceCount}} 台设备 · 已加入 {{joinDays}} 天</text>
			</view>
		</view>

		<!-- 设备管理卡片 -->
		<view class="block-title">设备</view>
		<view class="menu-card">
			<view class="menu-item" @click="goAddDevice">
				<view class="menu-icon-wrap bg-green">
					<text class="menu-icon">📶</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">添加设备 / 配网</text>
					<text class="menu-sub">连接新的摄像头</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
			<view class="menu-item" @click="goDeviceList">
				<view class="menu-icon-wrap bg-amber">
					<text class="menu-icon">📷</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">我的设备</text>
					<text class="menu-sub">管理已绑定设备</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
		</view>

		<!-- 通用菜单 -->
		<view class="block-title">通用</view>
		<view class="menu-card">
			<view class="menu-item" @click="goItem('pet')">
				<view class="menu-icon-wrap bg-cream">
					<text class="menu-icon">🐱</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">猫咪档案</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
			<view class="menu-item" @click="goItem('notify')">
				<view class="menu-icon-wrap bg-cream">
					<text class="menu-icon">🔔</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">消息通知</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
			<view class="menu-item" @click="goItem('help')">
				<view class="menu-icon-wrap bg-cream">
					<text class="menu-icon">💬</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">帮助与反馈</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
			<view class="menu-item" @click="goItem('about')">
				<view class="menu-icon-wrap bg-cream">
					<text class="menu-icon">ℹ️</text>
				</view>
				<view class="menu-body">
					<text class="menu-label">关于猫饭日记</text>
				</view>
				<text class="menu-arrow">›</text>
			</view>
		</view>

		<!-- 退出登录 -->
		<view class="logout-btn" @click="logout">
			<text class="logout-text">退出登录</text>
		</view>

		<view class="bottom-safe"></view>
	</view>
</template>

<script>
	export default {
		data() {
			return {
				userName: '猫饭用户',
				userAvatar: '/static/images/user-avatar.png',
				deviceCount: 0,
				joinDays: 1
			}
		},
		onShow() {
			this.loadUser()
		},
		methods: {
			loadUser() {
				const loginInfo = uni.getStorageSync('loginInfo')
				if (loginInfo && loginInfo.nickname) {
					this.userName = loginInfo.nickname
				}
				this.JLWXSDK.getDeviceList({ page: 1, limit: 50 }, (result) => {
					if (result.code === 2000 && result.data && result.data.deviceList) {
						this.deviceCount = result.data.deviceList.length
					}
				})
			},
			// 配网入口（接现有 addDevice 页）
			goAddDevice() {
				uni.navigateTo({ url: '/pages/bind/addDevice' })
			},
			goDeviceList() {
				uni.navigateTo({ url: '/pages/bind/addDevice' })
			},
			goItem(type) {
				const map = {
					pet: '猫咪档案',
					notify: '消息通知',
					help: '帮助与反馈',
					about: '关于猫饭日记'
				}
				uni.showToast({ title: map[type] + '即将上线', icon: 'none' })
			},
			logout() {
				uni.showModal({
					title: '退出登录',
					content: '确定要退出当前账号吗？',
					success: (res) => {
						if (res.confirm) {
							uni.removeStorageSync('loginInfo')
							uni.reLaunch({ url: '/pages/login/index' })
						}
					}
				})
			}
		}
	}
</script>

<style>
	.profile-page {
		min-height: 100vh;
		background: #F2EDE4;
		padding: 0 32rpx;
	}

	.page-header {
		padding: 40rpx 0 32rpx;
	}
	.page-title {
		font-size: 56rpx;
		font-weight: 700;
		color: #2B2620;
		letter-spacing: 4rpx;
	}

	/* 用户卡片 */
	.user-card {
		background: #FBF8F2;
		border-radius: 32rpx;
		padding: 40rpx 32rpx;
		display: flex;
		align-items: center;
		margin-bottom: 48rpx;
		box-shadow: 0 6rpx 24rpx rgba(140, 120, 90, 0.08);
	}
	.user-avatar {
		width: 120rpx;
		height: 120rpx;
		border-radius: 50%;
		background: #EDE6D8;
		flex-shrink: 0;
	}
	.user-info {
		margin-left: 28rpx;
	}
	.user-name {
		display: block;
		font-size: 38rpx;
		font-weight: 700;
		color: #2B2620;
		margin-bottom: 10rpx;
	}
	.user-sub {
		font-size: 26rpx;
		color: #A99C84;
	}

	/* 区块标题 */
	.block-title {
		font-size: 28rpx;
		font-weight: 600;
		color: #A99C84;
		margin: 0 8rpx 20rpx;
	}

	/* 菜单卡片 */
	.menu-card {
		background: #FBF8F2;
		border-radius: 28rpx;
		padding: 8rpx 28rpx;
		margin-bottom: 48rpx;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.06);
	}
	.menu-item {
		display: flex;
		align-items: center;
		padding: 28rpx 0;
		border-bottom: 2rpx solid #F0EADD;
	}
	.menu-item:last-child { border-bottom: none; }
	.menu-icon-wrap {
		width: 72rpx;
		height: 72rpx;
		border-radius: 20rpx;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.bg-green { background: rgba(111, 168, 111, 0.16); }
	.bg-amber { background: rgba(232, 162, 61, 0.16); }
	.bg-cream { background: #EDE6D8; }
	.menu-icon { font-size: 36rpx; }
	.menu-body {
		flex: 1;
		margin-left: 24rpx;
	}
	.menu-label {
		display: block;
		font-size: 30rpx;
		font-weight: 600;
		color: #4A4339;
	}
	.menu-sub {
		font-size: 24rpx;
		color: #A99C84;
		margin-top: 4rpx;
	}
	.menu-arrow {
		font-size: 40rpx;
		color: #C4B9A4;
		font-weight: 300;
	}

	/* 退出 */
	.logout-btn {
		background: #FBF8F2;
		border-radius: 28rpx;
		padding: 30rpx 0;
		text-align: center;
		box-shadow: 0 4rpx 16rpx rgba(140, 120, 90, 0.06);
	}
	.logout-text {
		font-size: 30rpx;
		color: #C66B5A;
		font-weight: 600;
	}

	.bottom-safe { height: 40rpx; }
</style>
