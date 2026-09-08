const SUBSCRIPTION_STATUSES = new Set(['accept', 'reject', 'ban', 'filter'])

function normalizeSubscriptionResult(result = {}, templateIds = []) {
	return (Array.isArray(templateIds) ? templateIds : []).reduce((output, templateId) => {
		const status = String(result && result[templateId] || '')
		output[templateId] = SUBSCRIPTION_STATUSES.has(status) ? status : 'unknown'
		return output
	}, {})
}

function requestSubscriptionMessage(wxApi, templateIds = []) {
	const ids = Array.isArray(templateIds) ? templateIds.filter(Boolean).slice(0, 3) : []
	if (!wxApi || typeof wxApi.requestSubscribeMessage !== 'function') {
		return Promise.reject(new Error('WECHAT_SUBSCRIPTION_UNAVAILABLE'))
	}
	if (!ids.length) return Promise.reject(new Error('WECHAT_SUBSCRIPTION_NOT_CONFIGURED'))
	return new Promise((resolve, reject) => {
		let settled = false
		const succeed = (result) => {
			if (settled) return
			settled = true
			resolve(result || {})
		}
		const fail = (error) => {
			if (settled) return
			settled = true
			const failure = new Error(String(error && (error.errMsg || error.message) || 'WECHAT_SUBSCRIPTION_FAILED'))
			failure.errCode = Number(error && error.errCode) || 0
			reject(failure)
		}
		try {
			const request = wxApi.requestSubscribeMessage({ tmplIds: ids, success: succeed, fail })
			if (request && typeof request.then === 'function') request.then(succeed).catch(fail)
		} catch (error) {
			fail(error)
		}
	})
}

function notificationStatusCopy(notifications = {}) {
	if (!notifications.configured) return '等待微信后台开通订阅消息模板'
	if (!notifications.enabled) return '提醒已关闭'
	const templates = Array.isArray(notifications.templates) ? notifications.templates : []
	const start = templates.find((item) => item.eventType === 'feeding_start')
	const end = templates.find((item) => item.eventType === 'feeding_end')
	const startCount = Number(start && start.remainingCount) || 0
	const endCount = Number(end && end.remainingCount) || 0
	if (startCount > 0 && endCount > 0) return '下一次开始与结束提醒已备好'
	if (startCount > 0) return '已备好开始提醒，还需领取结束提醒'
	if (endCount > 0) return '已备好结束提醒，还需领取开始提醒'
	return '需要领取下一次进食提醒'
}

module.exports = {
	SUBSCRIPTION_STATUSES,
	normalizeSubscriptionResult,
	requestSubscriptionMessage,
	notificationStatusCopy
}
