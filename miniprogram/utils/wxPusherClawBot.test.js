const test = require('node:test')
const assert = require('node:assert/strict')

const {
	CLAWBOT_ACTIVATION_URL,
	CLAWBOT_BIND_PATH,
	CLAWBOT_QR_MARGIN_PX,
	CLAWBOT_QR_SIZE_PX,
	clawBotQrCanvasStyle,
	normalizeWxPusherClawBot,
	wxPusherClawBotErrorCopy,
	wxPusherClawBotCopy
} = require('./wxPusherClawBot')

test('ClawBot state uses the official activation page and never invents delivery confirmation', () => {
	const pending = normalizeWxPusherClawBot({
		configured: true,
		bound: true,
		status: 'pending_confirmation'
	})
	assert.equal(pending.activationUrl, CLAWBOT_ACTIVATION_URL)
	assert.equal(pending.activationMethod, 'wxpusher_app')
	assert.equal(pending.activationPath, '/app/#/push-channel')
	assert.equal(CLAWBOT_BIND_PATH, '/app/#/push-channel')
	assert.equal(
		CLAWBOT_ACTIVATION_URL,
		'https://wxpusher.zjiecode.com/download/'
	)
	assert.match(wxPusherClawBotCopy(pending), /WxPusher App/)
	assert.doesNotMatch(wxPusherClawBotCopy(pending), /已送达/)
})

test('ClawBot active and expired copy expose an estimate rather than a guaranteed receipt', () => {
	assert.match(wxPusherClawBotCopy({ status: 'active', estimatedRemaining: 7 }), /预计本轮还可接收 7 条/)
	assert.match(wxPusherClawBotCopy({ status: 'reactivation_required' }), /WxPusher App/)
})

test('ClawBot QR canvas uses matching CSS pixels and keeps an explicit quiet zone', () => {
	assert.equal(CLAWBOT_QR_SIZE_PX, 320)
	assert.equal(CLAWBOT_QR_MARGIN_PX, 24)
	assert.equal(clawBotQrCanvasStyle(), 'width:320px;height:320px;')
})

test('ClawBot verification errors explain the failed stage without claiming delivery', () => {
	assert.match(wxPusherClawBotErrorCopy({ message: 'WXPUSHER_CLAWBOT_TEST_PENDING' }), /仍在投递/)
	assert.match(wxPusherClawBotErrorCopy({ code: 'WXPUSHER_CLAWBOT_TEST_FAILED' }), /投递失败/)
	assert.match(wxPusherClawBotErrorCopy(new Error('WXPUSHER_CLAWBOT_TEST_INVALID')), /重新发送/)
})
