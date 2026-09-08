const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const test = require('node:test')

const deployScriptPath = `${__dirname}/ecs-deploy.sh`

test("deployment pauses backend writes while creating the local rollback snapshot", async () => {
  const script = await readFile(deployScriptPath, 'utf8')
  const pauseIndex = script.indexOf("docker pause bobbo-backend");
  const snapshotIndex = script.indexOf('tar --numeric-owner -C / -czf "$backup_dir/runtime.tgz"');
  const resumeIndex = script.indexOf("resume_backend", snapshotIndex);

  assert.notEqual(pauseIndex, -1);
  assert.notEqual(snapshotIndex, -1);
  assert.notEqual(resumeIndex, -1);
  assert.ok(pauseIndex < snapshotIndex);
  assert.ok(snapshotIndex < resumeIndex);
});

test("deployment exit cleanup resumes a backend paused for snapshotting", async () => {
  const script = await readFile(deployScriptPath, 'utf8')
  const cleanupBody = script.match(/cleanup\(\) \{([\s\S]*?)\n\}/)?.[1] || "";

  assert.match(cleanupBody, /resume_backend/);
  assert.match(script, /trap cleanup EXIT/);
});
