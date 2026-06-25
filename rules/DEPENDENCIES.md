# Dependency Management Rules

## Current Dependencies

### Runtime Dependencies

| Package                        | Version  | Purpose                               |
| ------------------------------ | -------- | ------------------------------------- |
| `typebox`                      | ^1.0.0   | Runtime schema validation for tools   |
| `@earendil-works/pi-tui`       | *        | TUI component rendering               |

### Peer Dependencies

| Package                              | Version | Purpose                          |
| ------------------------------------ | ------- | -------------------------------- |
| `@earendil-works/pi-coding-agent`    | *       | Extension API, runtime types     |

### Dev Dependencies

| Package       | Version  | Purpose              |
| ------------- | -------- | -------------------- |
| `typescript`  | ^6.0.0   | Type checking, build |
| `vitest`      | ^4.0.0   | Test framework       |

## Dependency Rules

### Adding Dependencies

- NEVER introduce new third-party dependencies unless the task explicitly requires it
- Prefer built-in Node.js APIs over third-party packages
- When a new dependency is needed, verify it's actively maintained and has no security issues

### Package Manager

- Use npm (the package manager present in this project, determined by `package-lock.json`)
- NEVER mix package managers in the same project

### Version Pinning

- Runtime dependencies: use caret (`^`) for minor version flexibility
- Dev dependencies: use caret (`^`) for minor version flexibility
- Peer dependencies: use `*` (resolved by the host project)

### Lock File

- Always commit `package-lock.json`
- Run `npm install` (not `npm ci`) for development
- CI uses `npm install` via the release script

## Engine Requirements

- Node.js >= 18
- Supported OS: linux, darwin

## Updating Dependencies

```bash
# Check for outdated packages
npm outdated

# Update a specific package
npm update <package>

# Update all packages
npm update
```

## Anti-Patterns

| Anti-Pattern               | Detection                          | Fix                                    |
| -------------------------- | ---------------------------------- | -------------------------------------- |
| Unused dependency          | Import not found in source         | Remove from package.json               |
| Missing dependency         | Import without package.json entry  | Add to package.json and npm install    |
| Version conflict           | npm install warnings               | Resolve peer dependency conflicts      |
| Lock file drift            | package-lock.json out of sync      | Run npm install to regenerate          |
