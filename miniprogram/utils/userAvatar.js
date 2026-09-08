const { isRemoteAvatar, uploadCatAvatar } = require('./catAvatarUpload.js')

function isPersistedUserAvatar(value) {
	return isRemoteAvatar(String(value || '').trim())
}

function preferUserAvatar(currentValue, incomingValue) {
	const current = String(currentValue || '').trim()
	const incoming = String(incomingValue || '').trim()
	if (isPersistedUserAvatar(incoming)) return incoming
	if (isPersistedUserAvatar(current)) return current
	return incoming || current
}

async function uploadUserAvatar(options = {}) {
	const filePath = String(options.filePath || '').trim()
	if (!filePath) throw new Error('USER_AVATAR_REQUIRED')
	return uploadCatAvatar({
		...options,
		filePath,
		catId: 'profile'
	})
}

module.exports = {
	isPersistedUserAvatar,
	preferUserAvatar,
	uploadUserAvatar
}
