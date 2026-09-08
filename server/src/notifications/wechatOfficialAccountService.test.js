const crypto = require('node:crypto')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
	parseWechatEventXml,
	verifyWechatSignature
} = require('./wechatOfficialAccountService')

test('official account callback verifies WeChat SHA1 signatures', () => {
	const token = 'callback-token'
	const timestamp = '1787479000'
	const nonce = 'nonce-1'
	const signature = crypto.createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
	assert.equal(verifyWechatSignature({ token, timestamp, nonce, signature }), true)
	assert.equal(verifyWechatSignature({ token, timestamp, nonce, signature: 'bad' }), false)
})

test('official account event parser accepts safe subscribe XML and rejects entities', () => {
	const event = parseWechatEventXml(`
		<xml>
			<ToUserName><![CDATA[gh_bobbo]]></ToUserName>
			<FromUserName><![CDATA[official-openid]]></FromUserName>
			<MsgType><![CDATA[event]]></MsgType>
			<Event><![CDATA[subscribe]]></Event>
		</xml>
	`)
	assert.equal(event.fromUserName, 'official-openid')
	assert.equal(event.event, 'subscribe')
	assert.throws(
		() => parseWechatEventXml('<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><xml/>'),
		/WECHAT_OFFICIAL_XML_UNSAFE/
	)
})
