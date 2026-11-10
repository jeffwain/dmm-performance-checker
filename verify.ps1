# Runs this repo's tests. See the Verifying rules in claude-config/CLAUDE.md.
node --experimental-vm-modules test/run.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node --experimental-vm-modules test/render.mjs
if ($LASTEXITCODE) { exit $LASTEXITCODE }
node --test "tools/*.test.mjs"
exit $LASTEXITCODE
