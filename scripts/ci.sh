#!/usr/bin/env bash
set -euo pipefail

echo "==> CI Quick Gate (public): $(date)"
echo "Full verification runs on GitHub Actions (typecheck + format + lint +"
echo "  knip + madge + test + build + security audit)."
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

# Step 4: Tests
echo "--- Tests ---"
npm test
echo "  tests passed"
echo ""

# Step 5: CI config check
echo "--- CI config check ---"
test -f .github/workflows/ci.yml || {
  echo "  ci.yml missing -- generate via git-ops skill"
  exit 1
}
echo "  ci.yml present"
echo ""

echo "==> Quick gate PASSED -- push and let GitHub Actions run full CI"
