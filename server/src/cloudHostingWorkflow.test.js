const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const workflowPath = path.join(root, '.github', 'workflows', 'deploy-cloud-hosting.yml')

test('deployment targets production from main', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')
	const config = JSON.parse(fs.readFileSync(path.join(root, 'cloudbaserc.json'), 'utf8'))

	assert.equal(config.envId, 'YOUR_CLOUDBASE_ENV')
	assert.equal(config.cloudrun.name, 'cat-feeding-api')
	assert.match(workflow, /push:\s*\n\s+branches:\s*\[main\]/)
	assert.match(workflow, /workflow_dispatch:/)
	assert.match(workflow, /cancel-in-progress:\s*false/)
})

test('push deployments are limited to backend-owned paths', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')
	const match = workflow.match(
		/push:\s*\r?\n\s+branches:\s*\[main\]\s*\r?\n\s+paths:\s*\r?\n(?<paths>(?:\s+- .+\r?\n)+)/
	)

	assert.ok(match, 'main push trigger must define a paths filter')
	const paths = match.groups.paths
		.trim()
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*-\s+['"]?|['"]?\s*$/g, ''))

	assert.deepEqual(paths, [
		'server/**',
		'vision/**',
		'public/**',
		'bgm/**',
		'Dockerfile',
		'.dockerignore',
		'cloudbaserc.json',
		'.github/workflows/deploy-cloud-hosting.yml'
	])
	assert.ok(!paths.includes('miniprogram/**'))
})

test('deployment performs a full release and verifies it', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /@cloudbase\/cli@3\.6\.4/)
	assert.match(workflow, /TCB_SECRET_ID:\s*\$\{\{ secrets\.TCB_SECRET_ID \}\}/)
	assert.match(workflow, /TCB_SECRET_KEY:\s*\$\{\{ secrets\.TCB_SECRET_KEY \}\}/)
	assert.match(workflow, /npm ci --prefix server/)
	assert.match(workflow, /node --test server\/src\/\*\*\/\*\.test\.js miniprogram\/utils\/\*\.test\.js miniprogram\/config\/\*\.test\.js/)
	assert.match(workflow, /Configure Cloud Hosting runtime secrets/)
	assert.match(workflow, /CLOUDBASE_SECRET_ID:\s*\$\{\{ secrets\.TCB_SECRET_ID \}\}/)
	assert.match(workflow, /CLOUDBASE_SECRET_KEY:\s*\$\{\{ secrets\.TCB_SECRET_KEY \}\}/)
	assert.match(workflow, /envParams\.PUBLIC_BASE_URL\s*=\s*process\.env\.API_URL/)
	assert.match(workflow, /UpdateCloudRunServerConfig/)
	assert.match(workflow, /OpenAccessTypes:\s*previous\.OpenAccessTypes\.filter\(\(type\) => type !== 'PUBLIC'\)/)
	assert.match(workflow, /DescribeCloudRunDeployRecord/)
	assert.match(workflow, /UpdateCloudRunServer/)
	assert.match(workflow, /DeployType:\s*'repository'/)
	assert.match(workflow, /Repo:\s*'lil-goat\/cat-feeding-demo'/)
	assert.match(workflow, /Branch:\s*'main'/)
	assert.match(workflow, /ReleaseType:\s*'FULL'/)
	assert.match(workflow, /latest\.DeployId === baselineDeployId/)
	assert.match(workflow, /latest\.Status === 'normal'/)
	const serverDetailCalls = [...workflow.matchAll(/callCloudBase\('DescribeCloudRunServerDetail'/g)]
	assert.ok(serverDetailCalls.length >= 2, 'deployment must verify the newly created version is online')
	assert.match(workflow, /function onlineVersionNames/)
	assert.match(workflow, /const expectedVersion = latest\.VersionName \|\| `\$\{serverName\}-\$\{latest\.DeployId\}`/)
	assert.match(workflow, /onlineVersionNames\(detail\)\.includes\(expectedVersion\)/)
	assert.match(workflow, /is ready but not online yet/)
	assert.match(workflow, /health_status=\$\(curl --silent --show-error --output \/dev\/null --write-out '%\{http_code\}' --max-time 20/)
	assert.match(workflow, /health_status.*200.*health_status.*401/)
	assert.match(workflow, /Released health HTTP/)
	assert.doesNotMatch(workflow, /cloudrun traffic/)
})

test('deployment validates and synchronizes PushPlus runtime secrets', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	for (const secret of ['PUSHPLUS_TOKEN', 'PUSHPLUS_SECRET_KEY', 'PUSHPLUS_CALLBACK_SECRET']) {
		assert.match(workflow, new RegExp(`${secret}:\\s*\\$\\{\\{ secrets\\.${secret} \\}\\}`))
		assert.match(workflow, new RegExp(`envParams\\.${secret} = process\\.env\\.${secret}`))
	}
	assert.match(workflow, /const requiredRuntimeSecrets = \[/)
	assert.match(workflow, /if \(!String\(process\.env\[name\] \|\| ''\)\.trim\(\)\)/)
	assert.match(workflow, /throw new Error\(`\$\{name\} is required`\)/)
	assert.match(workflow, /Cloud Hosting runtime secrets configured/)
})

test('deployment keeps the JLink server identity aligned with the mini program SDK', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')
	const miniProgram = fs.readFileSync(path.join(root, 'miniprogram', 'main.js'), 'utf8')

	for (const name of ['uuid', 'appKey', 'appSecret', 'movedCard']) {
		const match = miniProgram.match(new RegExp(`${name}\\s*:\\s*['\"]?([^'\",\\s}]+)`))
		assert.ok(match, `mini program ${name} must be configured`)
		const envName = {
			uuid: 'JF_UUID',
			appKey: 'JF_APPKEY',
			appSecret: 'JF_APPSECRET',
			movedCard: 'JF_MOVECARD'
		}[name]
		assert.match(workflow, new RegExp(`envParams\\.${envName}\\s*=\\s*'${match[1]}'`))
	}
})

test('deployment configures the automation secret without deploying a CloudBase function', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /AUTOMATION_TICK_SECRET:\s*\$\{\{ secrets\.AUTOMATION_TICK_SECRET \}\}/)
	assert.match(workflow, /envParams\.AUTOMATION_TICK_SECRET\s*=\s*process\.env\.AUTOMATION_TICK_SECRET/)
	assert.doesNotMatch(workflow, /tcb fn deploy/)
})

test('deployment disables feed analysis model triggers while preserving the service', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /envParams\.FEED_ANALYSIS_ENABLED\s*=\s*'false'/)
})

test('deployment prints the Cloud Hosting build log when a repository build fails', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /DescribeCloudRunBuildLog/)
	assert.match(workflow, /BuildId:\s*latest\.BuildId/)
	assert.match(workflow, /buildLog\.Log\?\.FailType/)
	assert.match(workflow, /buildLog\.Log\?\.FailReason/)
	assert.match(workflow, /buildLog\.Log\?\.Text/)
})

test('deployment stops when a generated version is never promoted online', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /let forcedFullRelease = false/)
	assert.match(workflow, /if \(!forcedFullRelease\)/)
	assert.match(workflow, /callCloudBase\('ReleaseGray'/)
	assert.match(workflow, /GrayType:\s*'FLOW'/)
	assert.match(workflow, /VersionFlowItems:\s*\[/)
	assert.match(workflow, /VersionName:\s*expectedVersion/)
	assert.match(workflow, /FlowRatio:\s*100/)
	assert.match(workflow, /forcedFullRelease = true/)
	assert.match(workflow, /let readyButOfflineAttempts = 0/)
	assert.match(workflow, /readyButOfflineAttempts \+= 1/)
	assert.match(workflow, /readyButOfflineAttempts >= 20/)
	assert.match(workflow, /was not promoted online/)
})

test('deployment reuses the built image when repository version creation fails', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.match(workflow, /DescribeCloudBaseRunServerVersion/)
	assert.match(workflow, /}, 'tcb', '2018-06-08'\)/)
	assert.match(workflow, /let imageFallbackStarted = false/)
	assert.match(workflow, /if \(imageFallbackStarted\)/)
	assert.match(workflow, /DeployType:\s*'image'/)
	assert.match(workflow, /ImageUrl:\s*failedVersion\.ImageUrl/)
	assert.match(workflow, /ReleaseType:\s*'FULL'/)
	assert.match(workflow, /Direct image fallback started/)
})

test('deployment verifies anonymous API denial after release', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')
	const probes = [...workflow.matchAll(/\/api\/devices/g)]

	assert.ok(probes.length >= 1, 'released traffic must probe /api/devices')
	assert.match(workflow, /Released health HTTP/)
	assert.match(workflow, /"\$anonymous_status" = "401"/)
	assert.match(workflow, /\/api\/auth\/wechat-login/)
	assert.match(workflow, /x-wx-openid:\s*forged-user/)
	assert.match(workflow, /x-wx-source:\s*wx_client/)
	assert.match(workflow, /x-authmethod:\s*WX_SERVER_AUTH/)
	assert.match(workflow, /"\$spoofed_status" = "401"/)
})

test('deployment removes the temporary model test access while preserving production model paths', () => {
	const workflow = fs.readFileSync(workflowPath, 'utf8')

	assert.doesNotMatch(workflow, /secrets\.MODEL_TEST_TOKEN/)
	assert.match(workflow, /delete envParams\[name\]/)
	for (const name of [
		'MODEL_TEST_TOKEN',
		'MODEL_TEST_EXPIRES_AT',
		'MODEL_TEST_ALLOWED_SHA256',
		'MODEL_TEST_MAX_BYTES',
		'MODEL_TEST_TTL_MS',
		'MODEL_TEST_TEMP_DIR',
	]) {
		assert.match(workflow, new RegExp(`'${name}'`))
	}
	assert.match(workflow, /envParams\.FEED_ANALYSIS_VISION_TIMEOUT_MS\s*=\s*String\(30 \* 60 \* 1000\)/)
	assert.match(workflow, /envParams\.FEED_ANALYSIS_YOLO_MODEL\s*=\s*'\/app\/vision\/models\/yolo11s\.pt'/)
	assert.match(workflow, /envParams\.CAT_VISION_YOLO_MODEL\s*=\s*'\/app\/vision\/models\/yolo11s\.pt'/)
	assert.match(workflow, /envParams\.CAT_VISION_POSE_MODEL\s*=\s*'\/app\/vision\/models\/vitpose-s-apt36k\.onnx'/)
	assert.match(workflow, /envParams\.CAT_FACE_MODEL_DIR\s*=\s*'\/app\/vision\/models\/cat-face'/)
})
