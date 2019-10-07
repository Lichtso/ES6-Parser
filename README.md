# Evaluation for my Master Thesis
Parse and migrate a GIT repository containing ES6 JavaScript into a version-controlled graph-database to analyze it semantically using graph queries.

## Usage
`time node --max-old-space-size=4096 -expose-gc --always-compact --experimental-modules RepoMigration.mjs PathToGitRepo/ git-branch-name`
