const DEFAULT_LOGIN_RETRY_DELAYS_MS = Object.freeze([500, 1200])

function loginErrorText(error) {
  return [error && error.code, error && error.message, error && error.errMsg]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function isRetryableLoginError(error) {
  const statusCode = Number(error && error.statusCode) || 0
  const message = loginErrorText(error)
  if (message.includes('url not in domain list')) return false
  if ([429, 502, 503, 504].includes(statusCode)) return true
  if (statusCode > 0) return false
  if (message.includes('wechat_login_code_missing') || message.includes('wechat_login_request_failed')) return true
  return message.includes('backend_network_failed')
    || message.includes('timeout')
    || message.includes('connection reset')
    || message.includes('network error')
}

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

async function runLoginWithRetry(options = {}) {
  const requestCode = options.requestCode
  const loginBackend = options.loginBackend
  const retryDelays = Array.isArray(options.retryDelays)
    ? options.retryDelays.map((value) => Math.max(0, Number(value) || 0))
    : DEFAULT_LOGIN_RETRY_DELAYS_MS
  const wait = typeof options.wait === 'function' ? options.wait : defaultWait
  const onAttemptFailure = typeof options.onAttemptFailure === 'function'
    ? options.onAttemptFailure
    : () => {}
  if (typeof requestCode !== 'function' || typeof loginBackend !== 'function') {
    throw new Error('LOGIN_RETRY_CALLBACK_MISSING')
  }

  const maxAttempts = retryDelays.length + 1
  for (let index = 0; index < maxAttempts; index += 1) {
    try {
      const code = String(await requestCode(index + 1) || '').trim()
      if (!code) {
        const error = new Error('WECHAT_LOGIN_CODE_MISSING')
        error.code = 'WECHAT_LOGIN_CODE_MISSING'
        throw error
      }
      return await loginBackend(code, index + 1)
    } catch (error) {
      const retrying = index < retryDelays.length && isRetryableLoginError(error)
      const delayMs = retrying ? retryDelays[index] : 0
      onAttemptFailure(error, { attempt: index + 1, maxAttempts, retrying, delayMs })
      if (!retrying) throw error
      await wait(delayMs)
    }
  }
  throw new Error('LOGIN_RETRY_EXHAUSTED')
}

module.exports = {
  DEFAULT_LOGIN_RETRY_DELAYS_MS,
  isRetryableLoginError,
  runLoginWithRetry,
}
