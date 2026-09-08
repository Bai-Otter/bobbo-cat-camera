function parseBirthday(value) {
	const text = String(value || '').trim()
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
	const [year, month, day] = text.split('-').map(Number)
	const date = new Date(year, month - 1, day)
	if (Number.isNaN(date.getTime())) return null
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function formatCatAge(birthday, fallbackAge = '', now = new Date()) {
	const born = parseBirthday(birthday)
	const current = now instanceof Date ? now : new Date(now)
	if (!born || Number.isNaN(current.getTime()) || born > current) return String(fallbackAge || '')
	let years = current.getFullYear() - born.getFullYear()
	let months = current.getMonth() - born.getMonth()
	if (current.getDate() < born.getDate()) months -= 1
	if (months < 0) {
		years -= 1
		months += 12
	}
	if (years > 0) return `${years}岁`
	return `${Math.max(0, months)}个月`
}

module.exports = { formatCatAge, parseBirthday }
