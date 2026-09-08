const test = require('node:test')
const assert = require('node:assert/strict')

const {
	normalizeNotificationDelivery,
	notificationDeliveryCopy,
	waitForNotificationDelivery
} = require('./notificationDelivery')

test('normalizes unknown provider states as pending instead of claiming delivery', () => {
	assert.deepEqual(normalizeNotificationDelivery({ deliveryId: 'delivery-1', status: 'accepted' }), {
		id: 'delivery-1',
		provider: '',
		status: 'pending',
		error: ''
	})
	assert.equal(notificationDeliveryCopy({ status: 'pending' }), '正在投递到微信')
	assert.equal(
		notificationDeliveryCopy({ provider: 'wxpusher', status: 'delivered' }),
		'WxPusher 已接收，请以微信实际消息为准'
	)
})

test('polls until the provider confirms final delivery', async () => {
	const states = ['pending', 'pending', 'delivered']
	const waits = []
	const delivery = await waitForNotificationDelivery({
		deliveryId: 'delivery-2',
		loadDelivery: async () => ({ delivery: { id: 'delivery-2', status: states.shift() } }),
		wait: async (delayMs) => { waits.push(delayMs) },
		intervalMs: 2000,
		maxAttempts: 10
	})

	assert.equal(delivery.status, 'delivered')
	assert.deepEqual(waits, [2000, 2000, 2000])
	assert.equal(notificationDeliveryCopy(delivery), '微信已送达')
})

test('returns pending after the bounded polling window', async () => {
	let calls = 0
	const delivery = await waitForNotificationDelivery({
		deliveryId: 'delivery-3',
		loadDelivery: async () => {
			calls += 1
			return { delivery: { id: 'delivery-3', provider: 'pushplus', status: 'pending' } }
		},
		wait: async () => {},
		maxAttempts: 3
	})

	assert.equal(calls, 3)
	assert.equal(delivery.status, 'pending')
	assert.equal(delivery.provider, 'pushplus')
})

test('surfaces a provider-confirmed failure', async () => {
	const delivery = await waitForNotificationDelivery({
		deliveryId: 'delivery-4',
		loadDelivery: async () => ({
			delivery: { id: 'delivery-4', status: 'failed', lastError: 'PUSHPLUS_REJECTED' }
		}),
		wait: async () => {}
	})

	assert.equal(delivery.status, 'failed')
	assert.equal(delivery.error, 'PUSHPLUS_REJECTED')
	assert.equal(notificationDeliveryCopy(delivery), '投递失败，请重试')
})
