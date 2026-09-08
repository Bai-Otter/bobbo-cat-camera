// 云函数：login
// 作用：通过 cloud.getWXContext() 直接拿 openid（无需 code2session），
//       在 users 集合按 openid 查/建用户记录，返回 openid + profile
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command
const COLL = 'users'

exports.main = async (event, context) => {
	const wxCtx = cloud.getWXContext()
	const openid = wxCtx.OPENID
	if (!openid) {
		return { ok: false, error: 'NO_OPENID' }
	}

	// 查现有记录
	const queryRes = await db.collection(COLL).where({ openid }).limit(1).get()
	if (queryRes.data && queryRes.data.length > 0) {
		const u = queryRes.data[0]
		return {
			ok: true,
			openid,
			isNew: false,
			profile: {
				avatar: u.avatar || '',
				nickname: u.nickname || ''
			},
			createdAt: u.createdAt
		}
	}

	// 新用户，建一条
	const now = Date.now()
	await db.collection(COLL).add({
		data: {
			openid,
			avatar: '',
			nickname: '',
			createdAt: now,
			updatedAt: now
		}
	})
	return {
		ok: true,
		openid,
		isNew: true,
		profile: { avatar: '', nickname: '' },
		createdAt: now
	}
}