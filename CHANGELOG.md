# Changelog

All notable changes to this project are documented here.

## [Unreleased]

- Add a direct MQTT-trigger demo flow with a local Mosquitto fixture.
- Add a Nuclio-owned Cron-trigger demo flow.

## [3.1.0] - 2026-08-23

- Add a shared dashboard circuit breaker for transient Nuclio outages.
- Add abortable in-flight dashboard and invocation requests during Node-RED shutdown.
- Add Compose and KinD canary jobs to continuous integration.
- Add operational metrics for dashboard requests, deployments, reconciliation, and invocations.
- Add optional Basic/Bearer dashboard authentication with typed values and credential-backed custom request headers.
- Add schema-assisted YAML completion and conservative configuration warnings.
- Add curated execution, scaling, resource, and Kubernetes Secret-reference helpers.
- Add endpoint-aware invocation status, including service, internal, and external routes.
- Require Node.js 22 or newer and Node-RED 4 or newer.
- Add package, lint, audit, Compose, and KinD checks to the release validation matrix.

## [3.0.1] - 2026-08-21

- Reorganized the README around installation and normal usage.
- Moved developer testing and fixture documentation to the end of the README.

## [3.0.0] - 2026-08-21

- Removed deprecated function-level credential overrides.
- Consolidated secret and non-secret YAML interpolation through deployment variables.

## [2.1.0] - 2026-08-21

- Added a disposable KinD Kubernetes canary deployment.

## [2.0.0] - 2026-08-20

- Hardened deployment reconciliation, project scoping, status handling, and orphan cleanup.
- Added conservative config and build fingerprinting for idempotent deployments.

## [1.5.0] - 2026-08-09

- Added explicit rebuild support for Git and archive-backed sources.
- Added a real Docker Compose smoke test against Nuclio.

## [1.4.0] - 2026-08-09

- Completed a maintainability and runtime-maturity pass.

## [1.3.0] - 2026-08-09

- Added invocation freshness tracking and unhealthy-state debounce.

## [1.2.0] - 2026-08-09

- Hardened secret paths and invocation error routing.

## [1.1.0] - 2026-02-20

- Improved deployment error reporting and runtime diagnostics.

## [1.0.0] - 2026-01-20

- Moved function configuration and deployment ownership into a shared config node.
- Added support for using functions from subflows.

## [0.0.1] - 2025-04-10

- Initial release.
