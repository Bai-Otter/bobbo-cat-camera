const test = require('node:test')
const assert = require('node:assert/strict')
const { formatCatAge } = require('./catAge.js')

test('formatCatAge calculates completed years and months', () => {
	const now = new Date('2026-08-20T00:00:00')
	assert.equal(formatCatAge('2023-08-19', '', now), '3岁')
	assert.equal(formatCatAge('2026-05-21', '', now), '2个月')
})

test('formatCatAge falls back for missing or future birthdays', () => {
	const now = new Date('2026-08-20T00:00:00')
	assert.equal(formatCatAge('', '2岁', now), '2岁')
	assert.equal(formatCatAge('2027-01-01', '2岁', now), '2岁')
	assert.equal(formatCatAge('2026-02-30', '2岁', now), '2岁')
})
