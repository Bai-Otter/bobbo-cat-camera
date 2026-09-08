function materialTimestamp(material = {}) {
	return Number(material.mealStartMs) || Number(material.createdAt) || 0
}

function newestTimestamp(material = {}) {
	return Number(material.updatedAt) || Number(material.createdAt) || 0
}

function decorateMaterial(material, device) {
	if (!material || typeof material !== 'object') return null
	return {
		...material,
		sourceDeviceSn: String(device && device.sn || ''),
		sourceDeviceName: String(device && (device.nickname || device.name) || '')
	}
}

function dedupeMaterials(materials) {
	const byKey = new Map()
	for (const material of materials) {
		if (!material) continue
		const key = `${material.sourceDeviceSn || ''}:${material.id || ''}`
		if (!byKey.has(key)) byKey.set(key, material)
	}
	return [...byKey.values()].sort((left, right) => (
		materialTimestamp(left) - materialTimestamp(right)
		|| String(left.id || '').localeCompare(String(right.id || ''))
	))
}

async function loadFoodcastCatalogForDevices({
	devices = [],
	date = '',
	fetchDaily,
	fetchMaterials
} = {}) {
	if (typeof fetchDaily !== 'function' || typeof fetchMaterials !== 'function') {
		throw new TypeError('FOODCAST_CATALOG_FETCHERS_REQUIRED')
	}
	const accessibleDevices = (Array.isArray(devices) ? devices : []).filter((device) => device && device.sn)
	if (!accessibleDevices.length) return { daily: null, materials: [], failedDeviceSns: [] }

	const results = await Promise.allSettled(accessibleDevices.map(async (device) => {
		const query = { deviceSn: device.sn, date }
		const [dailyResult, materialsResult] = await Promise.all([
			fetchDaily(query),
			fetchMaterials(query)
		])
		return {
			device,
			daily: decorateMaterial(dailyResult && dailyResult.daily, device),
			materials: (Array.isArray(materialsResult && materialsResult.materials)
				? materialsResult.materials
				: []).map((material) => decorateMaterial(material, device)).filter(Boolean)
		}
	}))

	const fulfilled = results.filter((result) => result.status === 'fulfilled').map((result) => result.value)
	if (!fulfilled.length) throw results[0].reason

	const daily = fulfilled.map((result) => result.daily).filter(Boolean)
		.sort((left, right) => newestTimestamp(right) - newestTimestamp(left))[0] || null
	const materials = dedupeMaterials(fulfilled.flatMap((result) => result.materials))
	const failedDeviceSns = results.map((result, index) => (
		result.status === 'rejected' ? String(accessibleDevices[index].sn) : ''
	)).filter(Boolean)

	return { daily, materials, failedDeviceSns }
}

module.exports = {
	dedupeMaterials,
	loadFoodcastCatalogForDevices
}
