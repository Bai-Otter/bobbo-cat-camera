const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const workflowPath = path.join(root, '.github', 'workflows', 'automation-recovery.yml')

test('automation recovery runs every five minutes and can be dispatched manually', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /schedule:\s*\r?\n\s+- cron:\s*['"]\*\/5 \* \* \* \*['"]/) 
	assert.match(workflow, /workflow_dispatch:/)
	assert.match(workflow, /cancel-in-progress:\s*false/)
})

test('automation recovery calls only the protected tick endpoint', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /AUTOMATION_TICK_SECRET:\s*\$\{\{ secrets\.AUTOMATION_TICK_SECRET \}\}/)
	assert.match(workflow, /--request POST/)
	assert.match(workflow, /x-automation-tick-secret: \$AUTOMATION_TICK_SECRET/)
	assert.match(workflow, /https:\/\/cat-feeding-api-285654-10-1445099516\.sh\.run\.tcloudbase\.com\/api\/internal\/automation\/tick/)
	assert.match(workflow, /--max-time 55/)
	assert.doesNotMatch(workflow, /tcb\s+(?:fn|cloudrun)|UpdateCloudRunServer|npm\s+(?:ci|install)/)
})
