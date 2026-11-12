# Lunar CI Tracer

A GitHub Action and GitLab CI template that install the [Lunar](https://github.com/earthly/lunar) CLI and use it to run the CI tracer.
The tracer instruments your workflow, triggering collectors and policies at the appropriate points during execution.

## Usage

Add the action as an early step in your workflow:

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Run Lunar CI Tracer
        id: lunar
        uses: earthly/lunar-ci-tracer@${LUNAR_VERSION}
        env:
          LUNAR_HUB_TOKEN: ${{ secrets.LUNAR_HUB_TOKEN }}
          LUNAR_HUB_HOST: your_hub_host

      - uses: actions/checkout@v4
      # ... rest of your workflow
```

The action installs the Lunar CLI (by default, the latest version available at the time the action release was created) and invokes `lunar ci-tracer run`, which fetches the CI/CD Tracer binary through your Lunar Hub on first use (caching it in `~/.lunar/bin`), verifies it, and attaches it to the workflow process. All subsequent steps are automatically instrumented. The Hub must be reachable when the action starts.

## Inputs

| Input | Default | Description |
|---|---|---|
| `version` | `${LUNAR_VERSION}` | Lunar CLI version to run. Defaults to the tracer version this action release was cut for. |

## Outputs

| Output | Description |
|---|---|
| `agent-installed` | `'true'` when the tracer started and became ready; `'false'` when the tracer could not be installed and the job was allowed to continue (see `LUNAR_STRICT_MODE`). |

Downstream steps can branch on it:

```yaml
- name: Run checks that need the tracer
  if: steps.lunar.outputs.agent-installed == 'true'
  run: ./run-traced-tests.sh
```

## Configuration

All configuration is passed via environment variables.

### Required

| Variable | Description |
|---|---|
| `LUNAR_HUB_TOKEN` | Auth token for your Hub installation. |
| `LUNAR_HUB_HOST` | Hostname of your Hub installation. Must be reachable from the runner. |

### Optional

| Variable | Default | Description |
|---|---|---|
| `LUNAR_HUB_GRPC_PORT` | `443` | Hub's gRPC port. |
| `LUNAR_HUB_HTTP_PORT` | `443` | Hub's HTTP port. |
| `LUNAR_HUB_INSECURE` | `false` | Set to `true` when connecting to a Hub without TLS. |
| `LUNAR_STRICT_MODE` | `false` | When `true`, the step fails if the tracer cannot be installed and started. When unset or `false`, the action emits an error annotation and lets the rest of the job continue uninstrumented. Same env var the agent itself uses to gate Hub-setup failures. |
| `LUNAR_LOG_LEVEL` | `error` | Log verbosity. Set to `debug` for troubleshooting. |
| `LUNAR_GIT_BASE_URL` |   | GitHub API base URL. Required for GitHub Enterprise Server. |

## Failure Handling

Tracer installation failures (CLI download, tracer download through the Hub, tracer startup) are gated by `LUNAR_STRICT_MODE`:

- `LUNAR_STRICT_MODE=true`: the step fails with the error output.
- Unset or `false` (default): the action emits an `::error::` annotation plus a warning, sets `agent-installed` to `false`, and the step succeeds so the rest of the job continues without instrumentation.

## How It Works

The action runs as a job step. It downloads the `lunar` CLI and shells out to `lunar ci-tracer run`, which fetches the tracer binary through your Hub on first use and execs it. The tracer attaches to the current shell process via ptrace and traces all commands executed by subsequent steps in the same job.

The tracer exits automatically when the job completes.

## Requirements

- **Linux x86_64** runners (GitHub-hosted or self-hosted).
- Network access from the runner to your Lunar Hub.

## GitLab CI

Include `gitlab.yml` with the required `hub-host` input and extend `.lunar-tracer` in each job to trace. Use a release tag containing GitLab CI support; the template pins its matching CLI version.

```yaml
include:
  - remote: 'https://raw.githubusercontent.com/earthly/lunar-ci-tracer/<release-tag>/gitlab.yml'
    inputs:
      hub-host: hub.example.com

build:
  extends: .lunar-tracer
  script:
    - make build

test:
  extends: .lunar-tracer
  script:
    - make test
```

The hidden `.lunar-tracer` template downloads the CLI into `$CI_PROJECT_DIR/.lunar/bin`, adds it to `PATH`, and runs `lunar ci-tracer run --ci-type gitlab` directly in `before_script`. The CLI downloads and verifies the tracer through the Hub, attaches it to the job shell, and returns once ready. Subsequent `before_script` and `script` commands are traced; GitLab's separate `after_script` shell is outside that process tree. Download or startup failures fail the job.

The `hub-host` input sets `LUNAR_HUB_HOST` for every job extending the template. GitLab issues an OIDC ID token directly into `LUNAR_HUB_TOKEN`, using the input as its audience. This must match the Hub's `HUB_AUTH_AUDIENCE`; override `id_tokens.LUNAR_HUB_TOKEN.aud` in your job if the audience differs from the hostname. Remove or appropriately scope any existing project/group `LUNAR_HUB_TOKEN` variable, because it overrides the issued ID token. You can override `LUNAR_CLI_VERSION` to select another compatible CLI release.

Keep your existing job images and runner selection. Your job image must provide a shell, `curl`, and CA certificates on Linux x86_64, and allow ptrace attachment. GitLab-managed `saas-linux-*` runners support this; self-managed containers need ptrace permissions. The Hub must be reachable from the job.

If a job has its own `before_script`, explicitly include the tracer setup before your commands, because GitLab replaces inherited arrays:

```yaml
build:
  extends: .lunar-tracer
  before_script:
    - !reference [.lunar-tracer, before_script]
    - ./my-setup.sh
  script:
    - make build
```

## License

Copyright Earthly Technologies, Inc. All rights reserved.
