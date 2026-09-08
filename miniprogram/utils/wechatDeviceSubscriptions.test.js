const test = require('node:test')
const assert = require('node:assert/strict')

const {
	normalizeDeviceSubscriptionResult,
	requestSubscribeDeviceMessage,
	subscriptionStatusCopy
} = require('./wechatDeviceSubscriptions.js')

test('device subscription results keep only requested template statuses', () => {
	assert.deepEqual(normalizeDeviceSubscriptionResult({
		errMsg: 'requestSubscribeDeviceMessage:ok',
		'a': 'accept',
		'b': 'acceptWithAudio',
		'forged': 'accept',
		'c': 'unexpected'
	}, ['a', 'b', 'c']), {
		a: 'accept',
		b: 'acceptWithAudio',
		c: 'unknown'
	})
})

test('requestSubscribeDeviceMessage supports the WeChat callback API', async () => {
	const calls = []
	const wxApi = {
		requestSubscribeDeviceMessage(options) {
			calls.push(options)
			options.success({ errMsg: 'requestSubscribeDeviceMessage:ok', tmpl1: 'accept' })
		}
	}
	const result = await requestSubscribeDeviceMessage(wxApi, {
		tmplIds: ['tmpl1'],
		sn: 'SN001',
		snTicket: 'ticket',
		modelId: 'model-1'
	})

	assert.equal(calls.length, 1)
	assert.deepEqual(result, { errMsg: 'requestSubscribeDeviceMessage:ok', tmpl1: 'accept' })
})

test('requestSubscribeDeviceMessage reports unsupported clients', async () => {
	await assert.rejects(
		requestSubscribeDeviceMessage({}, { tmplIds: ['tmpl1'] }),
		/WECHAT_DEVICE_SUBSCRIPTION_UNAVAILABLE/
	)
})

test('device subscription status distinguishes full and partial long-term access', () => {
	assert.equal(subscriptionStatusCopy({ configured: false }), '微信长期提醒正在开通')
	assert.equal(subscriptionStatusCopy({ configured: true, enabled: true }), '长期提醒已开启')
	assert.equal(subscriptionStatusCopy({ configured: true, partiallyEnabled: true }), '部分长期提醒已开启')
})
