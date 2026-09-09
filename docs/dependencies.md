# Dependency changes

Coding commands default to no network. For ordinary public npm or PyPI installation, use `job_start` with `network: "registries"`. The command still runs in the development container without production credentials or host administration access. Use normal npm/pip commands; the runner supplies the restricted proxy automatically. `node_modules` and `.venv` remain in that workspace for later offline tests.

The proxy permits HTTPS to `registry.npmjs.org`, `pypi.org`, and `files.pythonhosted.org`. It rejects private/loopback/metadata addresses and other destinations. Private registries, Git dependencies, arbitrary download sites, and packages that require additional installation endpoints are outside this initial policy.

For an npm deployment, finish installation and testing, then call `dependency_prepare` with the current workspace revision. Recover the resulting job through `job_status`; a successful result includes `preparedDependenciesId`. The bundle records package/lockfile hashes, runtime architecture, Node major version, image, and content digest. Supply that identifier when deploying the exact matching source. Deployment extracts the sealed bundle without running installation scripts as root.

Prepared bundles are limited to 512 MiB archived, 1 GiB expanded, 100,000 files, and 256 MiB per file. Retention is bounded to twenty bundles and 2 GiB total. Quota failures are explicit; retained results are not silently discarded.

Python dependencies can be installed and tested in development workspaces. The initial new-app deployment adapter supports the Python standard library and source modules; it does not yet deploy third-party virtual environments. New applications are stateless services. See [new-project deployment](new-project-deployment.md) and [qualification status](autonomy-milestone.md).
