# Lunar CI Tracer for GitLab

The `tracer` CI/CD component installs the [Lunar](https://github.com/earthly/lunar) CLI and starts the CI tracer in your GitLab job. The tracer attaches to the job shell and runs CI collectors for subsequent commands.

## Usage

Include the `tracer` component, pass your Hub hostname as `hub-host`, and extend `.lunar-tracer` in each job you want to trace. Replace `<release-tag>` with a release containing [GitLab CI support](https://github.com/earthly/lunar/pull/3730). The template pins the corresponding CLI version; `v5.0.0` predates this support.

```yaml
include:
  - component: gitlab.com/earthly-technologies/lunar-ci-tracer/tracer@<release-tag>
    inputs:
      hub-host: hub.example.com

stages: [build, test]

build:
  extends: .lunar-tracer
  stage: build
  script:
    - make build

unit-tests:
  extends: .lunar-tracer
  stage: test
  script:
    - make test-unit

integration-tests:
  extends: .lunar-tracer
  stage: test
  script:
    - make test-integration
```

GitLab runs `build` first, then the two test jobs can run in parallel. Keep your existing job images and runner selection.

For GitLab Self-Managed, use a remote include because component references resolve only within the same GitLab instance:

```yaml
include:
  - remote: 'https://gitlab.com/earthly-technologies/lunar-ci-tracer/-/raw/<release-tag>/templates/tracer.yml'
    inputs:
      hub-host: hub.example.com
```

## Configuration

The required `hub-host` input sets `LUNAR_HUB_HOST`. GitLab issues an OIDC ID token directly into `LUNAR_HUB_TOKEN`, with the Hub hostname as its audience. Configure the Hub to trust your GitLab issuer and match this audience with `HUB_AUTH_AUDIENCE`. If the audience differs, override `id_tokens.LUNAR_HUB_TOKEN.aud` in your job.

Remove or appropriately scope existing project/group `LUNAR_HUB_TOKEN` variables: they override the issued ID token.

| Variable | Default | Description |
|---|---|---|
| `LUNAR_CLI_VERSION` | `${LUNAR_VERSION}` | CLI release to download. Override only with a release containing GitLab CI support. |
| `LUNAR_STRICT_MODE` | `false` | Set to `true` to fail the job if tracer download, setup, or startup fails. By default, the job warns and continues without instrumentation. |

If your job has its own `before_script`, include the tracer setup explicitly because GitLab replaces inherited arrays:

```yaml
build:
  extends: .lunar-tracer
  before_script:
    - !reference [.lunar-tracer, before_script]
    - ./my-setup.sh
  script:
    - make build
```

## Requirements and lifecycle

- Linux x86_64 with a shell, `curl`, `mktemp`, and CA certificates.
- Network access to GitHub releases and your Lunar Hub.
- Permission to attach with ptrace. GitLab-managed `saas-linux-*` runners support this; self-managed containers must allow ptrace attachment.

Each job downloads the CLI into a unique directory under `/tmp`, adds it to `PATH`, and runs `lunar ci-tracer run --ci-type gitlab` in `before_script`. Installation leaves the checked-out repository unchanged. The CLI downloads and verifies the tracer through the Hub, attaches it to the job shell, and returns once ready.

Subsequent `before_script` and `script` commands are traced. GitLab's separate `after_script` shell is outside that process tree. Commands share one synthetic job step; individual `script` entries are not reported as separate steps. The tracer finalizes the run when the attached shell exits, subject to the runner's container shutdown lifecycle.

## Releases

The release workflow in [earthly/lunar-ci-tracer on GitHub](https://github.com/earthly/lunar-ci-tracer) updates this repository and creates the matching release tag. The generated component at `templates/tracer.yml` and README use the released CLI version.

## License

Copyright Earthly Technologies, Inc. All rights reserved.
