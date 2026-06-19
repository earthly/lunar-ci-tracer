# Lunar CI Tracer

A GitHub Action that installs the [Lunar](https://github.com/earthly/lunar) CLI, and uses it to run the CI tracer. 
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
        uses: earthly/lunar-ci-tracer@v2.3.2
        env:
          LUNAR_HUB_TOKEN: ${{ secrets.LUNAR_HUB_TOKEN }}
          LUNAR_HUB_HOST: your_hub_host

      - uses: actions/checkout@v4
      # ... rest of your workflow
```

The action installs the Lunar CLI (by default, the latest version available at the time the action release was created) and invokes `lunar ci-tracer run`, which fetches the agent binary through your Lunar Hub on first use (caching it in `~/.lunar/bin`), verifies it, and attaches it to the workflow process. All subsequent steps are automatically instrumented. The Hub must be reachable when the action starts.

## Inputs

| Input | Default | Description |
|---|---|---|
| `version` | `v2.3.2` | Lunar CLI version to run. Defaults to the agent version this action release was cut for. |

## Outputs

| Output | Description |
|---|---|
| `agent-installed` | `'true'` when the agent started and became ready; `'false'` when the agent could not be installed and the job was allowed to continue (see `LUNAR_STRICT_MODE`). |

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
| `LUNAR_STRICT_MODE` | `false` | When `true`, the step fails if the agent cannot be installed and started. When unset or `false`, the action emits an error annotation and lets the rest of the job continue uninstrumented. Same env var the agent itself uses to gate Hub-setup failures. |
| `LUNAR_LOG_LEVEL` | `error` | Log verbosity. Set to `debug` for troubleshooting. |
| `LUNAR_GIT_BASE_URL` |   | GitHub API base URL. Required for GitHub Enterprise Server. |

## Failure Handling

Agent installation failures (CLI download, agent download through the Hub, agent startup) are gated by `LUNAR_STRICT_MODE`:

- `LUNAR_STRICT_MODE=true`: the step fails with the error output.
- Unset or `false` (default): the action emits an `::error::` annotation plus a warning, sets `agent-installed` to `false`, and the step succeeds so the rest of the job continues without instrumentation.

## How It Works

The action runs as a job step. It downloads the `lunar` CLI and shells out to `lunar ci-tracer run`, which fetches the agent binary through your Hub on first use and execs it. The agent attaches to the current shell process via ptrace and traces all commands executed by subsequent steps in the same job.

The agent exits automatically when the job completes.

## Requirements

- **Linux x86_64** runners (GitHub-hosted or self-hosted).
- Network access from the runner to your Lunar Hub.

## License

Copyright Earthly Technologies, Inc. All rights reserved.
