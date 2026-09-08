const FINAL_DELIVERY_STATES = new Set(['delivered', 'failed'])

function cleanText(value, maxLength = 160) {
	return String(value || '').trim().slice(0, maxLength)
}

function normalizeNotificationDelivery(value = {}) {
	const status = cleanText(value.status, 24)
	return {
		id: cleanText(value.id || value.deliveryId, 160),
		provider: cleanText(value.provider, 40),
		status: ['pending', 'delivered', 'failed'].includes(status) ? status : 'pending',
		error: cleanText(value.error || value.lastError, 160)
	}
}

function notificationDeliveryCopy(value = {}) {
	const delivery = normalizeNotificationDelivery(value)
	if (delivery.status === 'delivered') {
		return delivery.provider === 'wxpusher' ? 'WxPusher 已接收，请以微信实际消息为准' : '微信已送达'
	}
	if (delivery.status === 'failed') return '投递失败，请重试'
	return '正在投递到微信'
}

async function waitForNotificationDelivery({
	deliveryId,
	loadDelivery,
	wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
	intervalMs = 2000,
	maxAttempts = 10
} = {}) {
	const id = cleanText(deliveryId, 160)
	if (!id) throw new Error('NOTIFICATION_DELIVERY_ID_REQUIRED')
	if (typeof loadDelivery !== 'function') throw new Error('NOTIFICATION_DELIVERY_LOADER_REQUIRED')

	let delivery = normalizeNotificationDelivery({ id, status: 'pending' })
	for (let attempt = 0; attempt < Math.max(1, Number(maxAttempts) || 1); attempt += 1) {
		await wait(Math.max(0, Number(intervalMs) || 0))
		const response = await loadDelivery(id)
		delivery = normalizeNotificationDelivery(response && (response.delivery || response))
		if (FINAL_DELIVERY_STATES.has(delivery.status)) return delivery
	}
	return delivery
}

module.exports = {
	normalizeNotificationDelivery,
	notificationDeliveryCopy,
	waitForNotificationDelivery
}
