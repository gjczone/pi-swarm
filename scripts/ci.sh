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

# Step 2: Type check
echo "--- Type check ---"
npm run typecheck
echo "  type check passed"
echo ""

# Step 3: Tests
echo "--- Tests ---"
npm test
echo "  tests passed"
echo ""

# Step 4: Build and dist artifacts
echo "--- Build and dist artifacts ---"
npm run build
test -f dist/index.js
test -f dist/index.d.ts
echo "  build succeeded, dist artifacts present"
echo ""

# Step 5: CI config check
echo "--- CI config check ---"
test -f .github/workflows/ci.yml || { echo "  ci.yml missing -- generate via git-ops skill"; exit 1; }
echo "  ci.yml present"
echo ""

echo "==> Quick gate PASSED -- push and let GitHub Actions run full CI"
