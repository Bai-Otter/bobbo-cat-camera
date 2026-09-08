// 云函数：updateProfile
// 作用：根据 cloud.getWXContext().OPENID 鉴权，
//       把 avatar / nickname 写到 users 集合（按 openid 匹配，无则建）
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLL = 'users'

function pickPatch(event) {
	const patch = {}
	if (typeof event.avatar === 'string' && event.avatar) patch.avatar = event.avatar
	if (typeof event.nickname === 'string') {
		const n = event.nickname.trim()
		if (n) patch.nickname = n
	}
	return patch
}

exports.main = async (event, context) => {
	const wxCtx = cloud.getWXContext()
	const openid = wxCtx.OPENID
	if (!openid) return { ok: false, error: 'NO_OPENID' }

	const patch = pickPatch(event)
	if (Object.keys(patch).length === 0) {
		return { ok: false, error: 'EMPTY_PATCH' }
	}
	patch.updatedAt = Date.now()

	// 查现有
	const queryRes = await db.collection(COLL).where({ openid }).limit(1).get()
	if (queryRes.data && queryRes.data.length > 0) {
		const id = queryRes.data[0]._id
		await db.collection(COLL).doc(id).update({ data: patch })
		const after = await db.collection(COLL).doc(id).get()
		const u = after.data || {}
		return {
			ok: true,
			openid,
			profile: { avatar: u.avatar || '', nickname: u.nickname || '' }
		}
	}

	// 没有就建
	const now = Date.now()
	const created = Object.assign({
		openid,
		avatar: '',
		nickname: '',
		createdAt: now,
		updatedAt: now
	}, patch)
	await db.collection(COLL).add({ data: created })
	return {
		ok: true,
		openid,
		profile: { avatar: created.avatar || '', nickname: created.nickname || '' }
	}
}