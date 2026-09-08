<template>
	<!-- 统一线性图标：单色描边，高级简约。size 单位 rpx，color 可覆盖 -->
	<view class="cat-icon" :style="{ width: size + 'rpx', height: size + 'rpx' }">
		<image v-if="src" class="icon-img" :src="src" mode="aspectFit"
			:style="{ width: size + 'rpx', height: size + 'rpx' }" />
	</view>
</template>

<script>
	// 线性图标库：每个图标是一段 SVG，描边色用 currentColor 占位，运行时替换成传入的 color。
	// 全部 24x24 viewBox，1.6 描边，圆角线帽——统一笔触语言。
	const ICONS = {
		// 餐盘（设备在线）
		plate: '<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.4"/>',
		// 时钟（最新动态）
		clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4v4.8l3.2 2"/>',
		// 胶片（今日片段）
		film: '<rect x="3.6" y="5.4" width="16.8" height="13.2" rx="2"/><path d="M3.6 9.2h16.8M3.6 14.8h16.8M8.4 5.4v13.2M15.6 5.4v13.2"/>',
		// 电量
		battery: '<rect x="3" y="8" width="15" height="8" rx="2"/><path d="M20.4 11v2"/><path d="M6.5 11.4v3.2"/>',
		// 播放
		play: '<path d="M8.5 6.6v10.8l9-5.4z"/>',
		// 电视/监控（实时画面）
		monitor: '<rect x="3.4" y="5" width="17.2" height="11.4" rx="2"/><path d="M8.6 19.6h6.8M12 16.4v3.2"/>',
		// 铃铛（通知）
		bell: '<path d="M6.6 10.2a5.4 5.4 0 0 1 10.8 0c0 4 1.4 5.2 1.4 5.2H5.2s1.4-1.2 1.4-5.2Z"/><path d="M10.2 18.4a1.9 1.9 0 0 0 3.6 0"/>',
		// 对勾
		check: '<path d="M6.5 12.4l3.6 3.6 7.4-8"/>',
		// WiFi（配网）
		wifi: '<path d="M4.2 9.4a11 11 0 0 1 15.6 0"/><path d="M7 12.4a7 7 0 0 1 10 0"/><path d="M9.8 15.4a3 3 0 0 1 4.4 0"/><circle cx="12" cy="18.2" r="0.6"/>',
		// 摄像头（我的设备）
		camera: '<rect x="3.4" y="7" width="17.2" height="11.6" rx="2.2"/><circle cx="12" cy="12.8" r="3.2"/><path d="M8.4 7l1.4-2.2h4.4L15.6 7"/>',
		// Settings: Fluent-style connected device display.
		'settings-devices': '<rect x="3.5" y="4.5" width="17" height="12.5" rx="2.5"/><circle cx="16.4" cy="8.6" r="1.4"/><path d="M8 20h8M12 17v3"/>',
		// Settings: quiet notification bell with one clean baseline.
		'settings-notifications': '<path d="M6.5 10a5.5 5.5 0 0 1 11 0v2.8c0 1.4.4 2.3 1.3 3.2H5.2c.9-.9 1.3-1.8 1.3-3.2Z"/><path d="M9.7 19h4.6"/>',
		// Settings: Material-style tune controls.
		'settings-tune': '<path d="M4 7h8M16 7h4"/><circle cx="14" cy="7" r="2"/><path d="M4 17h3M11 17h9"/><circle cx="9" cy="17" r="2"/>',
		// Settings: invite a family member to share a device.
		'settings-share': '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.6-3.4 2.5-5 5.5-5s4.9 1.6 5.5 5"/><path d="M17.5 8v6M14.5 11h6"/>',
		// Settings: account identity card.
		'settings-account': '<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10.5" r="2.3"/><path d="M5.5 16c.5-1.9 1.7-2.8 3.5-2.8s3 .9 3.5 2.8M15 9h3M15 13h3"/>',
		// Compact directional affordance used by settings rows.
		'chevron-right': '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
		// 猫脸（档案 / tab）
		cat: '<path d="M5.4 7.2l1.6 3M18.6 7.2l-1.6 3"/><path d="M5.6 9.6c-.6 2 .2 6.4 2 8 1 .9 2.6 1.4 4.4 1.4s3.4-.5 4.4-1.4c1.8-1.6 2.6-6 2-8"/><path d="M9.6 12.6h.02M14.4 12.6h.02"/><path d="M11 15.4c.6.5 1.4.5 2 0"/>',
		// 消息气泡
		chat: '<path d="M4.4 6.6h15.2v9.2H10l-3.6 3v-3H4.4z"/>',
		// 信息 i
		info: '<circle cx="12" cy="12" r="8.4"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.7"/>',
		// 眼睛
		eye: '<path d="M2.8 12s3.4-5.6 9.2-5.6 9.2 5.6 9.2 5.6-3.4 5.6-9.2 5.6S2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.8"/>',
		// 闭眼
		'eye-off': '<path d="M4.6 15.4A16 16 0 0 1 2.8 12s3.4-5.6 9.2-5.6c1.5 0 2.9.4 4.1 1"/><path d="M19.4 8.6A15.8 15.8 0 0 1 21.2 12s-3.4 5.6-9.2 5.6c-1.5 0-2.9-.4-4.1-1"/><path d="M3.8 3.8l16.4 16.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
		// 房子（今日 tab）
		home: '<path d="M4.4 11L12 5l7.6 6"/><path d="M6.2 10.4v8h11.6v-8"/>',
		'home-solid': '<path d="M12 3.2 3.8 10a.9.9 0 0 0-.3.7V19a2 2 0 0 0 2 2h4.3v-5.6h4.4V21h4.3a2 2 0 0 0 2-2v-8.3a.9.9 0 0 0-.3-.7Z" fill="CURRENT_COLOR" stroke="none"/>',
		video: '<rect x="2.8" y="6.8" width="12.7" height="10.4" rx="2.6"/><path d="M15.5 10.8 20.4 8.2a.5.5 0 0 1 .8.4v6.8a.5.5 0 0 1-.8.4l-4.9-2.6"/>',
		'video-solid': '<rect x="2.8" y="6.8" width="12.7" height="10.4" rx="2.6" fill="CURRENT_COLOR" stroke="none"/><path d="M16.3 10.4 20.4 8.2a.5.5 0 0 1 .8.4v6.8a.5.5 0 0 1-.8.4l-4.1-2.2Z" fill="CURRENT_COLOR" stroke="none"/>',
		foodcast: '<rect x="2.8" y="5" width="18.4" height="14" rx="3"/><path d="M10.4 9.3a.4.4 0 0 1 .6-.35l4 2.7a.4.4 0 0 1 0 .7l-4 2.7a.4.4 0 0 1-.6-.35Z"/>',
		'foodcast-solid': '<rect x="2.8" y="5" width="18.4" height="14" rx="3" fill="CURRENT_COLOR" stroke="none"/><path d="M10.4 9.3a.4.4 0 0 1 .6-.35l4 2.7a.4.4 0 0 1 0 .7l-4 2.7a.4.4 0 0 1-.6-.35Z" fill="#FFFFFF" stroke="none"/>',
		profile: '<circle cx="12" cy="12" r="8.7"/><circle cx="12" cy="10" r="3"/><path d="M6.4 18.2a6.5 6.5 0 0 1 11.2 0"/>',
		'profile-solid': '<circle cx="12" cy="12" r="9.5" fill="CURRENT_COLOR" stroke="none"/><circle cx="12" cy="9.8" r="3" fill="#FFFFFF" stroke="none"/><path d="M6.2 18a7 7 0 0 1 11.6 0 9.5 9.5 0 0 1-11.6 0Z" fill="#FFFFFF" stroke="none"/>',
		// 趋势图
		chart: '<path d="M4 18V6"/><path d="M4 18h16"/><path d="M6.5 14.5l3.5-4 3.2 2.5 4.8-6"/>',
		// 滑杆（偏好设置）
		sliders: '<path d="M4 7h10M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2M10 17h10"/><circle cx="8" cy="17" r="2"/>',
		// 盾牌（设备状态）
		shield: '<path d="M12 3.8l7 3v5.4c0 4.2-2.8 6.8-7 8-4.2-1.2-7-3.8-7-8V6.8z"/><path d="M8.8 12.2l2.1 2.1 4.5-4.7"/>',
		// 分享
		share: '<circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="M7.8 11l8.4-5M7.8 13l8.4 5"/>',
		// 日历
		calendar: '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 9.5h16"/>',
		// Bottom navigation: compact activity bars.
		'activity-bars': '<rect x="4" y="12" width="3" height="8" rx="1.5"/><rect x="10.5" y="5" width="3" height="15" rx="1.5"/><rect x="17" y="9" width="3" height="11" rx="1.5"/>',
		// Bottom navigation: feeding bowl with a small front badge.
		'food-bowl': '<path d="M4.5 9.5h15l-1.1 7.2a3 3 0 0 1-3 2.5H8.6a3 3 0 0 1-3-2.5z"/><path d="M6 9.5 7.2 5h9.6L18 9.5"/><path d="M9.2 14.5c1.7 1.2 3.9 1.2 5.6 0"/>',
		// Filled cat face used by the selected profile tab.
		'cat-solid': '<path d="M5.2 8.2 6.8 3.8 10 6a8.5 8.5 0 0 1 4 0l3.2-2.2 1.6 4.4c1.1 1.5 1.7 3.3 1.7 5.2 0 4.4-3.8 7.1-8.5 7.1s-8.5-2.7-8.5-7.1c0-1.9.6-3.7 1.7-5.2Z" fill="CURRENT_COLOR" stroke="CURRENT_COLOR"/><circle cx="8.8" cy="12.5" r="1" fill="#FFFFFF" stroke="none"/><circle cx="15.2" cy="12.5" r="1" fill="#FFFFFF" stroke="none"/><path d="M10.7 16c.8.7 1.8.7 2.6 0" stroke="#FFFFFF"/>',
		// 退出
		logout: '<path d="M14 7.6V5.4H5.4v13.2H14v-2.2"/><path d="M10 12h9M16 9l3 3-3 3"/>'
	}

	export default {
		name: 'cat-icon',
		props: {
			name: { type: String, required: true },
			size: { type: [Number, String], default: 44 },
			color: { type: String, default: '#5A6B84' },
			stroke: { type: [Number, String], default: 1.6 }
		},
		computed: {
			src() {
				const path = ICONS[this.name]
				if (!path) return ''
				const resolvedPath = path.replace(/CURRENT_COLOR/g, this.color)
				// 把 currentColor 思路换成直接注入 stroke 颜色
				const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${this.color}" stroke-width="${this.stroke}" stroke-linecap="round" stroke-linejoin="round">${resolvedPath}</svg>`
				return 'data:image/svg+xml,' + encodeURIComponent(svg)
			}
		}
	}
</script>

<style>
	.cat-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.icon-img { display: block; }
</style>
