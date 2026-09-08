function foodcastStageText(job = {}) {
	if (job.status === 'queued') return '等待生成'
	if (job.status === 'ready') return '吃播已生成'
	if (job.status === 'failed') return '生成失败'
	if (job.status === 'expired') return '成片已过期'
	if (job.stage === 'preparing') return '正在准备录像'
	if (job.stage === 'retrying') return '正在重试'
	if (job.status === 'running') return '正在剪辑和配乐'
	return '准备生成'
}

function foodcastErrorMessage(code) {
	const messages = {
		NO_FEEDING_SEGMENTS: '这段时间没有识别到猫咪进食',
		NO_CUTE_HIGHLIGHTS: '这次进食还没有识别到可爱瞬间',
		BGM_LIBRARY_EMPTY: '吃播曲库还没有配置音乐',
		BGM_NOT_FOUND: '歌曲暂不可用，请重新选择',
		RECORDING_UNAVAILABLE: '暂时无法读取这段录像',
		TRANSCODE_FAILED: '视频合成失败，请稍后重试',
		FOODCAST_EXPIRED: '这条吃播已过期，请重新生成',
		FOODCAST_NOT_READY: '吃播仍在生成中',
		FOODCAST_NOT_FOUND: '没有找到这条吃播'
	}
	return messages[String(code || '')] || '生成吃播时遇到问题，请稍后重试'
}

function callUni(api, method, options) {
	return new Promise((resolve, reject) => {
		api[method](Object.assign({}, options, { success: resolve, fail: reject }))
	})
}

async function guideAlbumPermission(api) {
	if (!api || typeof api.showModal !== 'function' || typeof api.openSetting !== 'function') return
	const modal = await callUni(api, 'showModal', {
		title: '需要相册权限',
		content: '请在设置中开启相册权限，再重新保存吃播。',
		confirmText: '去设置'
	}).catch(() => null)
	if (modal && modal.confirm) {
		await callUni(api, 'openSetting', {}).catch(() => null)
	}
}

async function saveFoodcastVideo(uniApi, url) {
	const api = uniApi || (typeof uni !== 'undefined' ? uni : null)
	if (!api || typeof api.downloadFile !== 'function' || typeof api.saveVideoToPhotosAlbum !== 'function') {
		throw new Error('SAVE_VIDEO_UNAVAILABLE')
	}
	const download = await callUni(api, 'downloadFile', { url })
	if (![200, 206].includes(Number(download && download.statusCode)) || !download.tempFilePath) {
		throw new Error('VIDEO_DOWNLOAD_FAILED')
	}
	try {
		await callUni(api, 'saveVideoToPhotosAlbum', { filePath: download.tempFilePath })
	} catch (error) {
		const message = String((error && (error.errMsg || error.message)) || error || '')
		if (/auth|authorize|permission|deny/i.test(message)) {
			await guideAlbumPermission(api)
			throw new Error('ALBUM_PERMISSION_DENIED')
		}
		throw new Error('SAVE_VIDEO_FAILED')
	}
}

module.exports = {
	foodcastErrorMessage,
	foodcastStageText,
	saveFoodcastVideo
}
