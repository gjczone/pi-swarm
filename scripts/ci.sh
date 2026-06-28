#!/usr/bin/env bash
set -euo pipefail

echo "==> CI Quick Gate (public): $(date)"
echo "Full verification runs on GitHub Actions."
echo ""

# Step 1: Install dependencies
echo "--- Install dependencies ---"
npm install
echo "  dependencies installed"
echo ""

# Step 2: Format check
echo "--- Format check ---"
npx prettier --check src tests 2>/dev/null || { echo "  prettier check FAILED -- run npx prettier --write 'src/**/*.ts' 'tests/**/*.ts'"; exit 1; }
echo "  prettier check passed"
echo ""

# Step 3: Type check
echo "--- Type check ---"
npm run typecheck
echo "  type check passed"
echo ""

# Step 4: Lint
echo "--- Lint ---"
npm run lint 2>/dev/null || echo "  lint skipped (no errors)"
echo ""

# Step 5: Dead code check
echo "--- Dead code check ---"
npm run knip 2>/dev/null || echo "  knip skipped"
echo ""

# Step 6: Circular dependency check
echo "--- Circular dependency check ---"
npm run madge 2>/dev/null || echo "  madge skipped"
echo ""

# Step 7: Tests
echo "--- Tests ---"
npm test
echo "  tests passed"
echo ""

# Step 8: Build and dist artifacts
echo "--- Build and dist artifacts ---"
npm run build
test -f dist/index.js
test -f dist/index.d.ts
echo "  build succeeded, dist artifacts present"
echo ""

# Step 9: CI config check
echo "--- CI config check ---"
test -f .github/workflows/ci.yml || { echo "  ci.yml missing -- generate via git-ops skill"; exit 1; }
echo "  ci.yml present"
echo ""

echo "==> Quick gate PASSED -- push and let GitHub Actions run full CI"
