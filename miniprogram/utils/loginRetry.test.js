const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_LOGIN_RETRY_DELAYS_MS,
  isRetryableLoginError,
  runLoginWithRetry,
} = require('./loginRetry')

test('retries transient backend failures with a fresh WeChat code each time', async () => {
  const requestedCodes = []
  const submittedCodes = []
  const waits = []
  let requestCount = 0

  const result = await runLoginWithRetry({
    requestCode: async () => {
      requestCount += 1
      const code = `fresh-code-${requestCount}`
      requestedCodes.push(code)
      return code
    },
    loginBackend: async (code) => {
      submittedCodes.push(code)
      if (submittedCodes.length < 3) {
        const error = new Error('request:fail connection reset')
        error.code = 'BACKEND_NETWORK_FAILED'
        error.statusCode = 0
        throw error
      }
      return { ok: true }
    },
    wait: async (delayMs) => waits.push(delayMs),
  })

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(requestedCodes, ['fresh-code-1', 'fresh-code-2', 'fresh-code-3'])
  assert.deepEqual(submittedCodes, requestedCodes)
  assert.deepEqual(waits, DEFAULT_LOGIN_RETRY_DELAYS_MS)
})

test('does not retry a rejected or malformed WeChat credential', async () => {
  let codeRequests = 0
  const error = new Error('WECHAT_LOGIN_PROVIDER_ERROR')
  error.code = 'WECHAT_LOGIN_PROVIDER_ERROR'
  error.statusCode = 401

  await assert.rejects(() => runLoginWithRetry({
    requestCode: async () => `code-${++codeRequests}`,
    loginBackend: async () => { throw error },
    wait: async () => assert.fail('permanent errors must not wait for a retry'),
  }), error)
  assert.equal(codeRequests, 1)
})

test('classifies gateway and timeout failures but not domain configuration errors as retryable', () => {
  assert.equal(isRetryableLoginError({ statusCode: 503 }), true)
  assert.equal(isRetryableLoginError({ code: 'BACKEND_NETWORK_FAILED', errMsg: 'request:fail timeout' }), true)
  assert.equal(isRetryableLoginError({ code: 'BACKEND_NETWORK_FAILED', errMsg: 'request:fail url not in domain list' }), false)
  assert.equal(isRetryableLoginError({ statusCode: 401, code: 'WECHAT_LOGIN_PROVIDER_ERROR' }), false)
})
