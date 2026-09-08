const test = require('node:test')
const assert = require('node:assert/strict')

const {
	normalizeSubscriptionResult,
	requestSubscriptionMessage,
	notificationStatusCopy
} = require('./wechatSubscriptions')

test('mini subscription requests both feeding templates from a direct user action', async () => {
	let requested = []
	const wxApi = {
		requestSubscribeMessage(options) {
			requested = options.tmplIds
			options.success({ start: 'accept', end: 'reject' })
		}
	}
	const result = await requestSubscriptionMessage(wxApi, ['start', 'end'])
	assert.deepEqual(requested, ['start', 'end'])
	assert.deepEqual(normalizeSubscriptionResult(result, requested), { start: 'accept', end: 'reject' })
})

test('notification copy describes exhausted and available grants honestly', () => {
	assert.match(notificationStatusCopy({ configured: false }), /等待微信后台/)
	assert.match(notificationStatusCopy({ configured: true, enabled: true, templates: [] }), /需要领取/)
	assert.match(notificationStatusCopy({
		configured: true,
		enabled: true,
		templates: [
			{ eventType: 'feeding_start', remainingCount: 1 },
			{ eventType: 'feeding_end', remainingCount: 1 }
		]
	}), /开始与结束/)
})
