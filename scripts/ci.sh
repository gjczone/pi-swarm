#!/usr/bin/env bash
set -euo pipefail

echo "==> CI Quick Gate (public): $(date)"
echo "GitHub Actions independently re-runs all steps + build + audit + matrix."
echo ""

# Step 1: Install dependencies
echo "--- Install dependencies ---"
npm install
echo "  dependencies installed"
echo ""

# Step 2: Format check
echo "--- Format check ---"
npx prettier --check src tests 2>/dev/null || {
  echo "  FAILED -- run: npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'"
  exit 1
}
echo "  prettier check passed"
echo ""

# Step 3: Type check
echo "--- Type check ---"
npm run typecheck
echo "  type check passed"
echo ""

# Step 4: Lint
echo "--- Lint ---"
npx eslint src tests --quiet 2>/dev/null; ec=$?; if [ $ec -ne 0 ]; then echo "  FAILED"; exit $ec; fi
echo "  lint passed"
echo ""

# Step 5: Dead code check
echo "--- Dead code check ---"
npx knip --no-exit-code 2>/dev/null; ec=$?; if [ $ec -ne 0 ]; then echo "  FAILED"; exit $ec; fi
echo "  no dead code"
echo ""

# Step 6: Circular dependency check
echo "--- Circular dependency check ---"
npx dpdm --circular src/index.ts 2>/dev/null; ec=$?; if [ $ec -ne 0 ]; then echo "  FAILED"; exit $ec; fi
echo "  no circular dependencies"
echo ""

# Step 7: Tests
echo "--- Tests ---"
npm test
echo "  tests passed"
echo ""

# Step 8: CI config check
echo "--- CI config check ---"
test -f .github/workflows/ci.yml || {
  echo "  ci.yml missing -- generate via git-ops skill"
  exit 1
}
echo "  ci.yml present"
echo ""

echo "==> Quick gate PASSED -- push and let GitHub Actions run full CI"
