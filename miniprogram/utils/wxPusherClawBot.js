const CLAWBOT_BIND_PATH = '/app/#/push-channel'
const CLAWBOT_ACTIVATION_URL = 'https://wxpusher.zjiecode.com/download/'
const CLAWBOT_QR_SIZE_PX = 320
const CLAWBOT_QR_MARGIN_PX = 24

function cleanText(value, maxLength = 1024) {
	return String(value || '').trim().slice(0, maxLength)
}

function normalizeWxPusherClawBot(value = {}) {
	const rawStatus = cleanText(value.status, 40)
	const status = ['not_bound', 'pending_confirmation', 'active', 'reactivation_required'].includes(rawStatus)
		? rawStatus
		: 'not_bound'
	return {
		configured: !!value.configured,
		bound: !!value.bound,
		status,
		confirmedAt: Math.max(0, Number(value.confirmedAt) || 0),
		activeUntil: Math.max(0, Number(value.activeUntil) || 0),
		estimatedUsed: Math.max(0, Number(value.estimatedUsed) || 0),
		estimatedRemaining: Math.max(0, Number(value.estimatedRemaining) || 0),
		needsReactivation: !!value.needsReactivation,
		activationMethod: cleanText(value.activationMethod, 40) || 'wxpusher_app',
		activationPath: cleanText(value.activationPath, 120) || CLAWBOT_BIND_PATH,
		activationUrl: cleanText(value.activationUrl) || CLAWBOT_ACTIVATION_URL
	}
}

function wxPusherClawBotCopy(value = {}) {
	const state = normalizeWxPusherClawBot(value)
	if (state.status === 'active') {
		return `微信直达已确认，预计本轮还可接收 ${state.estimatedRemaining} 条`
	}
	if (state.status === 'reactivation_required') {
		return '本轮微信直达已到期或用完，请向 ClawBot 发送任意消息；若没有对话入口，请回 WxPusher App 续期'
	}
	if (state.status === 'pending_confirmation') {
		return 'WxPusher 已绑定；微信 ClawBot 需在 WxPusher App 的“推送渠道”里绑定'
	}
	return '请先完成 WxPusher 账号绑定'
}

function clawBotQrCanvasStyle() {
	return `width:${CLAWBOT_QR_SIZE_PX}px;height:${CLAWBOT_QR_SIZE_PX}px;`
}

function wxPusherClawBotErrorCopy(value = {}) {
	const code = cleanText(value && (value.code || value.message || value), 120)
	if (code.includes('WXPUSHER_CLAWBOT_TEST_PENDING')) return '测试提醒仍在投递，请稍后重试'
	if (code.includes('WXPUSHER_CLAWBOT_TEST_FAILED')) return '测试提醒投递失败，请重新发送'
	if (code.includes('WXPUSHER_CLAWBOT_TEST_INVALID')) return '这次测试已经失效，请重新发送测试提醒'
	if (code.includes('NOTIFICATION_TEST_RATE_LIMITED')) return '操作太快，请 30 秒后再试'
	return '微信直达测试失败，请稍后重试'
}

module.exports = {
	CLAWBOT_ACTIVATION_URL,
	CLAWBOT_BIND_PATH,
	CLAWBOT_QR_MARGIN_PX,
	CLAWBOT_QR_SIZE_PX,
	clawBotQrCanvasStyle,
	normalizeWxPusherClawBot,
	wxPusherClawBotErrorCopy,
	wxPusherClawBotCopy
}
