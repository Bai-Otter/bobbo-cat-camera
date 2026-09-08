<template>
	<view class="login-page" :class="'layout-' + layoutTier">
		<view class="login-shell">
			<view class="brand-zone">
				<view class="brand-logo">
					<image
						class="brand-logo-image"
						src="/static/images/bobbo-logo.png"
						mode="aspectFit"
					/>
				</view>
				<text class="brand-name">布卜布卜</text>
				<text class="brand-tagline">每一餐，都值得被看见</text>
			</view>

			<view class="login-body">
				<view class="login-panel">
					<text class="panel-eyebrow">WELCOME HOME</text>
					<text class="panel-title">从今天开始，记录猫咪的一天</text>
					<text class="section-desc">使用微信身份登录。首次登录将创建布卜布卜账号。</text>
					<button class="btn-primary" :disabled="logging" @click="wxLogin">
						<text class="btn-primary-text">{{ logging ? '正在登录...' : '微信登录' }}</text>
					</button>
					<view class="login-meta">
						<view class="meta-mark"></view>
						<text class="meta-text">安全、快速，不需要记密码</text>
					</view>
				</view>

				<view v-if="isTrialBuild" class="debug-panel">
					<view class="debug-heading">
						<text class="debug-title">体验版连接诊断</text>
						<button class="debug-probe" :disabled="debugProbing" @click="probeBackend">{{ debugProbing ? '测试中' : '测试后台' }}</button>
					</view>
					<text class="debug-line">环境：{{ debugContext.envVersion || '未知' }} · AppID：{{ debugContext.appId || '未知' }}</text>
					<text class="debug-line debug-url">地址：{{ debugContext.baseUrl || '未知' }}</text>
					<scroll-view class="debug-log" scroll-y>
						<text v-for="(line, index) in debugLines" :key="index" class="debug-log-line">{{ line }}</text>
					</scroll-view>
				</view>
				<view class="tips" v-else-if="debugLog">
					<text class="tips-text">{{ debugLog }}</text>
				</view>
			</view>
		</view>

		<view class="login-footer">
			<text class="agreement">登录即表示同意使用微信身份创建布卜布卜账号。</text>
		</view>
	</view>
</template>

<script>
	const { callBackend } = require('@/utils/backendClient.js')
	const { buildUrl, getRequestBaseUrl } = require('@/utils/backendClient.js')
	const { BACKEND_RUNTIME } = require('@/config/backend.js')
	const { runLoginWithRetry } = require('@/utils/loginRetry.js')
	const {
		saveAppSession
	} = require('@/utils/appAuth.js')
	const { postLoginRoute } = require('@/utils/shareInvite.js')
	const {
		getSafeViewportHeight,
		resolveLoginLayoutTier
	} = require('@/utils/loginLayout.js')

	export default {
		data() {
			return {
				logging: false,
				debugLog: '',
				debugLines: [],
				debugProbing: false,
				debugContext: { envVersion: '', appId: '', baseUrl: '' },
				layoutTier: 'regular'
			}
		},
			onLoad() {
				this.refreshDebugContext()
				this.refreshLayoutTier()
			},
			onShow() {
				this.refreshDebugContext()
				this.refreshLayoutTier()
			},
			methods: {
				refreshDebugContext() {
					try {
						const account = typeof wx !== 'undefined' && typeof wx.getAccountInfoSync === 'function'
							? wx.getAccountInfoSync() || {}
							: {}
						const miniProgram = account.miniProgram || {}
						this.debugContext = {
							envVersion: String(miniProgram.envVersion || '').toLowerCase(),
							appId: String(miniProgram.appId || ''),
							baseUrl: getRequestBaseUrl(uni, BACKEND_RUNTIME, typeof wx !== 'undefined' ? wx : null)
						}
					} catch (error) {
						this.debugContext = { envVersion: '', appId: '', baseUrl: '' }
					}
				},
				appendDebugLine(message) {
					const line = `${new Date().toLocaleTimeString()} ${String(message || '')}`
					this.debugLines = this.debugLines.concat(line).slice(-12)
					console.log('[login-debug]', line)
				},
				formatDebugError(error) {
					const item = error || {}
					const responseData = item.responseData ? ` data=${JSON.stringify(item.responseData).slice(0, 420)}` : ''
					return `错误 code=${item.code || ''} status=${item.statusCode || 0} message=${item.message || item.errMsg || item}${item.url ? ` url=${item.url}` : ''}${responseData}`
				},
				probeBackend() {
					if (this.debugProbing) return
					this.debugProbing = true
					this.refreshDebugContext()
					const url = buildUrl('/health', null, uni, BACKEND_RUNTIME, typeof wx !== 'undefined' ? wx : null)
					this.appendDebugLine(`探测开始 url=${url}`)
					uni.request({
						url,
						method: 'GET',
						timeout: 8000,
						success: (response) => {
							this.appendDebugLine(`探测结果 status=${response && response.statusCode || 0} data=${JSON.stringify(response && response.data || '').slice(0, 240)}`)
						},
						fail: (error) => this.appendDebugLine(`探测失败 errMsg=${error && error.errMsg || ''} errno=${error && error.errno || ''}`),
						complete: () => { this.debugProbing = false }
					})
				},
			refreshLayoutTier() {
				try {
					let systemInfo = {}
					if (typeof uni.getWindowInfo === 'function') {
						systemInfo = uni.getWindowInfo() || {}
					} else if (typeof uni.getSystemInfoSync === 'function') {
						systemInfo = uni.getSystemInfoSync() || {}
					}
					const safeViewportHeight = getSafeViewportHeight(systemInfo)
					this.layoutTier = safeViewportHeight > 0
						? resolveLoginLayoutTier(safeViewportHeight)
						: 'regular'
				} catch (err) {
					this.layoutTier = 'regular'
					console.log('[login] layout tier fallback', err)
				}
			},
			logMsg(msg) {
				this.debugLog = msg
				if (this.isTrialBuild) this.appendDebugLine(msg)
				console.log('[login]', msg)
			},
			async wxLogin() {
				if (this.logging) return
				this.logging = true
				this.refreshDebugContext()
				if (this.isTrialBuild) this.appendDebugLine(`登录点击 env=${this.debugContext.envVersion} base=${this.debugContext.baseUrl}`)
				this.logMsg('正在确认微信身份...')

				// #ifdef MP-WEIXIN
				try {
					const payload = await runLoginWithRetry({
						requestCode: (attempt) => this.requestWechatLoginCode(attempt),
						loginBackend: (code, attempt) => this.loginBackend(code, attempt),
						onAttemptFailure: (error, state) => {
							console.warn('[login] login attempt failed', { attempt: state.attempt, retrying: state.retrying, error })
							if (this.isTrialBuild) {
								this.appendDebugLine(`${this.formatDebugError(error)} attempt=${state.attempt}/${state.maxAttempts}${state.retrying ? ` retryIn=${state.delayMs}ms` : ''}`)
							}
							if (state.retrying) this.logMsg('网络波动，正在自动重试...')
						}
					})
					if (this.isTrialBuild) this.appendDebugLine(`登录响应成功 keys=${Object.keys(payload || {}).join(',')}`)
					const profile = saveAppSession({
						sessionToken: payload.sessionToken,
						user: payload.user || {}
					})
					this.logMsg('登录成功')
					this.finishLoginNavigation(profile)
				} catch (err) {
					console.log('[login] backend login failed', err)
					this.logging = false
					this.logMsg('登录服务暂时不可用，请稍后重试')
					uni.showToast({ title: '登录服务暂不可用', icon: 'none' })
				}
				// #endif
				// #ifndef MP-WEIXIN
				this.logging = false
				this.logMsg('请在微信小程序环境登录')
				// #endif
			},
			requestWechatLoginCode(attempt = 1) {
				return new Promise((resolve, reject) => {
					wx.login({
						success: (res) => {
							const code = String((res && res.code) || '').trim()
							if (this.isTrialBuild) this.appendDebugLine(`wx.login success attempt=${attempt} codeLength=${code.length}`)
							if (code) resolve(code)
							else {
								const error = new Error('WECHAT_LOGIN_CODE_MISSING')
								error.code = 'WECHAT_LOGIN_CODE_MISSING'
								reject(error)
							}
						},
						fail: (original) => {
							const error = new Error(original && original.errMsg || 'WECHAT_LOGIN_REQUEST_FAILED')
							error.code = 'WECHAT_LOGIN_REQUEST_FAILED'
							error.errMsg = original && original.errMsg || ''
							reject(error)
						}
					})
				})
			},
			loginBackend(code, attempt = 1) {
				this.logMsg(attempt > 1 ? `正在重新连接登录服务（${attempt}/3）...` : '正在登录布卜布卜账号...')
				if (this.isTrialBuild) this.appendDebugLine(`登录请求 ${buildUrl('/api/auth/wechat-login', null, uni, BACKEND_RUNTIME, typeof wx !== 'undefined' ? wx : null)}`)
				return callBackend('/api/auth/wechat-login', {
					method: 'POST',
					data: { code, syncSource: 'login-page' },
					requestId: `login_${Date.now()}_${attempt}`
				})
			},
			finishLoginNavigation(profile = {}) {
				this.logging = false
				const hasAvatar = !!profile.avatar
				const hasNickname = !!(profile.nickname && String(profile.nickname).trim())
				if (hasAvatar && hasNickname) {
					uni.reLaunch({ url: postLoginRoute() })
					return
				}
				uni.redirectTo({ url: '/pages/login/profile-setup' })
			}
		},
		computed: {
			isTrialBuild() {
				return String(this.debugContext.envVersion || '').toLowerCase() === 'trial'
			}
		}
	}
</script>

<style lang="scss" scoped>
	.login-page {
		min-height: 100vh;
		box-sizing: border-box;
		background: #FBFBFA;
		padding: calc(120rpx + constant(safe-area-inset-top)) 48rpx calc(40rpx + constant(safe-area-inset-bottom));
		padding: calc(120rpx + env(safe-area-inset-top)) 48rpx calc(40rpx + env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		color: #141414;
	}
	.login-page.layout-roomy { padding-top: calc(152rpx + env(safe-area-inset-top)); }
	.login-page.layout-compact { padding-top: calc(72rpx + env(safe-area-inset-top)); }
	.login-shell { width: 100%; flex: 1; display: flex; flex-direction: column; }
	.brand-zone { text-align: center; margin-bottom: 44rpx; }
	.brand-logo {
		width: 260rpx;
		height: 76rpx;
		margin: 0 auto 18rpx;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.brand-logo-image { width: 260rpx; height: 76rpx; display: block; }
	.brand-name { display: block; font-size: 44rpx; line-height: 58rpx; font-weight: 700; color: #141414; }
	.brand-tagline { display: block; margin-top: 8rpx; color: #5A5A56; font-size: 24rpx; line-height: 34rpx; }
	.login-body { flex-shrink: 0; display: flex; flex-direction: column; }
	.login-panel {
		box-sizing: border-box;
		padding: 36rpx 32rpx 28rpx;
		background: #FFFFFF;
		border: 2rpx solid #E8E8E5;
		border-radius: 24rpx;
	}
	.panel-eyebrow { display: block; color: #989893; font-size: 18rpx; line-height: 26rpx; letter-spacing: 2rpx; }
	.panel-title { display: block; margin-top: 10rpx; color: #141414; font-size: 34rpx; line-height: 46rpx; font-weight: 650; }
	.section-desc { display: block; margin-top: 18rpx; font-size: 24rpx; line-height: 38rpx; color: #989893; }
	.btn-primary { border: none; box-sizing: border-box; }
	.btn-primary::after { border: none; }
	.btn-primary {
		width: 100%;
		min-height: 88rpx;
		margin: 30rpx 0 0;
		background: #141414;
		border-radius: 14rpx;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.btn-primary[disabled] { background: #C4C4C0; }
	.btn-primary-text { color: #ffffff; font-size: 32rpx; font-weight: 700; }
	.login-meta { display: flex; align-items: center; justify-content: center; margin-top: 22rpx; }
	.meta-mark { width: 12rpx; height: 12rpx; margin-right: 10rpx; border-radius: 50%; background: #2FA35C; }
	.meta-text { color: #989893; font-size: 21rpx; line-height: 30rpx; }
	.tips {
		padding: 14rpx 20rpx;
		margin-top: 20rpx;
		background: #F1F1EF;
		border: 2rpx solid #E8E8E5;
		border-radius: 12rpx;
	}
	.tips-text {
		display: block;
		font-size: 23rpx;
		color: #5A5A56;
		text-align: center;
		line-height: 1.4;
	}
	.debug-panel { margin-top: 20rpx; padding: 20rpx; border: 2rpx solid #C9A24B; border-radius: 12rpx; background: #F1F1EF; }
	.debug-heading { display: flex; align-items: center; justify-content: space-between; }
	.debug-title { color: #5A5A56; font-size: 24rpx; line-height: 34rpx; font-weight: 700; }
	.debug-probe { flex: 0 0 auto; min-width: 132rpx; height: 54rpx; padding: 0 16rpx; margin: 0; border: 0; border-radius: 10rpx; background: #141414; color: #FFFFFF; font-size: 21rpx; line-height: 54rpx; }
	.debug-probe::after { border: 0; }
	.debug-probe[disabled] { opacity: 0.55; }
	.debug-line { display: block; margin-top: 10rpx; color: #5A5A56; font-size: 19rpx; line-height: 28rpx; word-break: break-all; }
	.debug-url { color: #9A4A40; }
	.debug-log { max-height: 250rpx; margin-top: 12rpx; padding-top: 10rpx; border-top: 2rpx solid #D8D8D5; box-sizing: border-box; }
	.debug-log-line { display: block; color: #5A5A56; font-size: 18rpx; line-height: 28rpx; word-break: break-all; }
	.login-footer { flex-shrink: 0; text-align: center; margin-top: 28rpx; }
	.agreement { font-size: 20rpx; color: #989893; }
</style>
