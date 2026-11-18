# Contributing

Thanks for helping. This guide covers the setup, the checks and the pull request flow.

## Setup

Use the Node version in `.nvmrc` (22). CI uses Node 22 too.

In the folder where you cloned the repository, check you are in the right place:

```sh
ls package.json
```

Install the dependencies:

```sh
npm install
```

To install exactly what CI installs, use `npm ci` instead.

## Checks

Run the checks before you open a pull request:

```sh
npm run typecheck
```

Runs `tsc` on the project.

```sh
npm test
```

Runs the vitest suite.

```sh
npm run coverage
```

Runs the vitest suite with coverage. It fails below 100% coverage.

```sh
npm run validate
```

Runs `claude plugin validate .`. It needs the `claude` command.

## Pull request flow

`main` is protected by a ruleset, so you cannot push to it directly. To change it:

1. Make a branch from `main`.
2. Commit your change and push the branch.
3. Open a pull request to `main`.
4. Wait for the checks to pass.
5. Squash merge the pull request.

The ruleset on `main`:

- A pull request is required.
- Squash merge is the only merge method.
- A review from a code owner is required (see `.github/CODEOWNERS`).
- The CodeQL check must pass.
- The repository admin can bypass the ruleset.

The checks run on every pull request to `main`:

- The `CI` workflow, job `build`: `npm ci`, `npm run typecheck`, `npm run coverage`.
- The `CodeQL` workflow: analyzes the JavaScript and TypeScript code. It also runs on pushes to `main` and weekly.

## House rules

- Code, identifiers, test names and log output are in English.
- Do not add comments to code. The only allowed marker is `TODO`.
- Do not use em dashes or en dashes anywhere: code, tests, docs or commit messages.

## Behavior changes

If your change changes behavior, update `README.md` and add the change under `## [Unreleased]` in `CHANGELOG.md`, in the same pull request.
