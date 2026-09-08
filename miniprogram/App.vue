<script>
	const { callBackend } = require('./utils/backendClient.js')
	const { clearAppSession, readAppAuthState, saveAppSession } = require('./utils/appAuth.js')
	const { STARTUP_SESSION_STATUS, refreshExistingSession, validateExistingSession } = require('./utils/appLaunch.js')
	const { captureShareToken, postLoginRoute, shouldRoutePendingShare } = require('./utils/shareInvite.js')

	function requestWechatLoginCode() {
		return new Promise((resolve, reject) => {
			if (typeof wx === 'undefined' || typeof wx.login !== 'function') {
				reject(new Error('WECHAT_LOGIN_UNAVAILABLE'))
				return
			}
			wx.login({
				success: (result) => {
					const code = String((result && result.code) || '').trim()
					if (code) resolve(code)
					else reject(new Error('WECHAT_LOGIN_CODE_MISSING'))
				},
				fail: reject
			})
		})
	}

	function routeToPendingShare(token, startupResolved) {
		if (typeof getCurrentPages !== 'function') return
		const pages = getCurrentPages()
		const current = pages && pages.length ? pages[pages.length - 1] : null
		if (!shouldRoutePendingShare({
			token,
			hasSession: readAppAuthState().hasSession,
			startupResolved,
			currentRoute: current && current.route
		})) return
		uni.reLaunch({ url: postLoginRoute() })
	}

	export default {
		globalData: {
			userProfile: null,
			userInfo: null,
			startupResolved: false,
			lastForegroundSyncAt: 0
		},
		methods: {
			syncDevicesInBackground() {
				const authState = readAppAuthState()
				if (!authState.hasSession || !(authState.profile && authState.profile.loggedIn)) return
				const now = Date.now()
				if (now - Number(this.globalData.lastForegroundSyncAt || 0) < 10000) return
				this.globalData.lastForegroundSyncAt = now
				callBackend('/api/app/foreground-sync', { method: 'POST' })
					.then((result) => console.log('[app] foreground device sync complete', {
						devices: Array.isArray(result && result.results) ? result.results.length : 0
					}))
					.catch((error) => console.warn('[app] foreground device sync unavailable', error && error.message))
			}
		},
		async onLaunch(options = {}) {
			console.log('布卜布卜 App Launch')
			this.globalData.startupResolved = false
			captureShareToken(options)
			const authState = readAppAuthState()
			const profile = authState.profile || {}

			if (authState.hasSession && profile.loggedIn) {
				console.log('[app] backend session found, refreshing', {
					openid: profile.openid,
					backendBaseUrl: authState.backendBaseUrl,
					sessionPreview: authState.sessionPreview
				})
				const refresh = await refreshExistingSession({
					authState,
					requestLoginCode: requestWechatLoginCode,
					loginBackend: (code) => callBackend('/api/auth/wechat-login', {
						method: 'POST',
						data: { code }
					}),
					saveSession: (payload) => saveAppSession({
						sessionToken: payload.sessionToken,
						user: payload.user || {}
					})
				})
				if (refresh.status === STARTUP_SESSION_STATUS.VALID) {
					console.log('[app] backend session refreshed, enter home')
					this.globalData.startupResolved = true
					this.syncDevicesInBackground()
					uni.reLaunch({ url: postLoginRoute() })
					return
				}
				console.warn('[app] backend session refresh unavailable, validating cached session')
				const latestAuthState = readAppAuthState()
				const validation = await validateExistingSession({
					authState: latestAuthState,
					requestProfile: () => callBackend('/api/profile'),
					readAuthState: () => readAppAuthState()
				})
				if (validation.status === STARTUP_SESSION_STATUS.INVALID) {
					console.log('[app] stale backend session cleared, stay on login page')
					this.globalData.startupResolved = true
					uni.reLaunch({ url: '/pages/login/index' })
					return
				}
				if (validation.status === STARTUP_SESSION_STATUS.UNAVAILABLE) {
					console.warn('[app] backend session validation unavailable, enter home with cached session')
				} else {
					console.log('[app] backend session valid, enter home')
				}
				this.globalData.startupResolved = true
				this.syncDevicesInBackground()
				uni.reLaunch({ url: postLoginRoute() })
				return
			}

			if (profile.loggedIn) {
				clearAppSession()
				console.log('[app] cleared stale login because backend session is missing')
			}

			console.log('[app] no backend session, stay on login page')
			this.globalData.startupResolved = true
			uni.reLaunch({ url: '/pages/login/index' })
		},
		onError(err) {
			const msg = String(err || '')
			if (msg.indexOf('timeout') !== -1 || msg.indexOf('SystemError') !== -1) {
				console.warn('[app] ignored sdk timeout noise', msg.substring(0, 120))
				return
			}
			console.error('[app] error:', err)
		},
		onShow(options = {}) {
			const shareToken = captureShareToken(options)
			routeToPendingShare(shareToken, this.globalData.startupResolved)
			this.syncDevicesInBackground()
			console.log('App Show')
		},
		onHide() {
			console.log('App Hide')
		}
	}
</script>

<style>
	page {
		background-color: #FBFBFA;
		font-family: -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif;
		color: #141414;
	}
	.primary-color { color: #141414; }
	.primary-bg { background-color: #141414; }
	.card {
		background: #FFFFFF;
		border: 2rpx solid #E8E8E5;
		border-radius: 24rpx;
		padding: 32rpx;
		margin: 24rpx;
	}
	.btn-primary {
		background: #141414;
		color: #FFFFFF;
		border-radius: 20rpx;
		padding: 24rpx 0;
		font-size: 32rpx;
		margin: 32rpx;
		border: none;
		text-align: center;
	}
	.btn-primary[disabled] { background: #C4C4C0; }
	.btn-secondary {
		background: #FFFFFF;
		color: #141414;
		border: 2rpx solid #E8E8E5;
		border-radius: 20rpx;
		padding: 24rpx 0;
		font-size: 32rpx;
		margin: 20rpx 32rpx;
	}
	.input-field {
		background: #FFFFFF;
		color: #141414;
		border-radius: 20rpx;
		padding: 24rpx 32rpx;
		margin: 16rpx 0;
		font-size: 30rpx;
		border: 2rpx solid #EFEFED;
	}
	.text-muted { color: #989893; font-size: 26rpx; }
	.text-success { color: #2FA35C; }
</style>
