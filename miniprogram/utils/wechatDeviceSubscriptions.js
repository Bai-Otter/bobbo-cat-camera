const DEVICE_SUBSCRIPTION_STATUSES = new Set([
	'accept',
	'acceptWithAudio',
	'reject',
	'ban',
	'filter'
])

function normalizeDeviceSubscriptionResult(result = {}, templateIds = []) {
	return (Array.isArray(templateIds) ? templateIds : []).reduce((output, templateId) => {
		const status = String(result && result[templateId] || '')
		output[templateId] = DEVICE_SUBSCRIPTION_STATUSES.has(status) ? status : 'unknown'
		return output
	}, {})
}

function requestSubscribeDeviceMessage(wxApi, ticket = {}) {
	if (!wxApi || typeof wxApi.requestSubscribeDeviceMessage !== 'function') {
		return Promise.reject(new Error('WECHAT_DEVICE_SUBSCRIPTION_UNAVAILABLE'))
	}
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
			const failure = new Error(String(error && (error.errMsg || error.message) || 'WECHAT_DEVICE_SUBSCRIPTION_FAILED'))
			failure.errCode = Number(error && error.errCode) || 0
			reject(failure)
		}
		try {
			const request = wxApi.requestSubscribeDeviceMessage({
				tmplIds: Array.isArray(ticket.tmplIds) ? ticket.tmplIds : [],
				sn: String(ticket.sn || ''),
				snTicket: String(ticket.snTicket || ''),
				modelId: String(ticket.modelId || ''),
				success: succeed,
				fail
			})
			if (request && typeof request.then === 'function') request.then(succeed).catch(fail)
		} catch (error) {
			fail(error)
		}
	})
}

function subscriptionStatusCopy(subscription = {}) {
	if (!subscription.configured) return '微信长期提醒正在开通'
	if (subscription.enabled) return '长期提醒已开启'
	if (subscription.partiallyEnabled) return '部分长期提醒已开启'
	const templates = Array.isArray(subscription.templates) ? subscription.templates : []
	if (templates.some((item) => item.status === 'ban')) return '模板暂不可用'
	if (templates.some((item) => item.status === 'reject')) return '长期提醒未允许'
	return '长期提醒未开启'
}

module.exports = {
	DEVICE_SUBSCRIPTION_STATUSES,
	normalizeDeviceSubscriptionResult,
	requestSubscribeDeviceMessage,
	subscriptionStatusCopy
}
