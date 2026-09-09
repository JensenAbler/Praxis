# New projects

Praxis can create a new local project, inspect/edit/test it through an isolated workspace, commit the result, and publish a new GitHub repository on `main`. Local coding works without a GitHub provisioning credential. Repository creation returns `GITHUB_SETUP_REQUIRED` until a protected credential is configured; it never reports a simulated remote success.

## Workflow

1. `project_create` accepts a lowercase hyphenated `name`, a `node`, `python`, or `static` template, and an idempotency key. Poll `git_operation_status` until completion.
2. Use the returned project ID with `project_inspect` and `workspace_create`. Run the registered validation command, edit, test, and review the diff.
3. `git_commit` creates a real local commit even before the repository exists remotely.
4. `project_publish` accepts the project ID, the completed commit operation ID, a fresh idempotency key, and optional visibility. Private is the default. Omitting the commit operation publishes only the initial scaffold.
5. Later changes use the existing `project_sync`, `git_commit`, and `git_push` workflow.

Project IDs contain an owner digest and validated slug. Registrations, source access, workspace creation, and publication enforce the owner. Tool arguments cannot select a host path, GitHub account, remote URL, arbitrary credential, or arbitrary deployment service.

Node projects contain `app.js`, `server.js`, a native Node test, and a lockfile without third-party packages. Python projects use the standard library and unittest. Static projects contain HTML/CSS, a health file, and an offline document check. The server templates honor `PORT`, default to 3000, and expose `/healthz`.

## Durable publication

The trusted Git broker initializes a bare repository and creates a deterministic root commit without checking out or executing source. Its export is verified against the manifest before the coding service registers a project. The initial project and each first publication produce immutable source exports.

The GitHub provisioner checks that the account matches the configured account and that the repository name is unused. It records intent before creating the repository, adds a unique writable deploy key, and pushes the chosen commit with an absent-head lease. Ordinary Git pushes use that repository-specific key. The provisioning token is never passed to Git, a coding process, a workspace, a source export, or an operation receipt.

Unknown create/key/push outcomes retain the operation and its intent. Recovery observes the exact repository marker, public key, or main commit. It never repeats an ambiguous effect. Read-only status may complete final push observation; it cannot initiate an unattempted remote step. To resume an earlier uncertain provisioning phase, repeat `project_publish` with the same arguments and idempotency key. Existing repositories are never adopted or overwritten.

## Protected broker configuration

The publishing service accepts:

```json
{
  "projectProvisioning": {
    "account": "JensenAbler",
    "directory": "/var/lib/praxis-git/projects",
    "knownHostsFile": "/var/lib/praxis-git/home/.ssh/known_hosts",
    "tokenFile": "/var/lib/praxis-git/project-provisioning-token",
    "maximumProjects": 50
  }
}
```

The directory and token must belong to the trusted publishing service. The token file must be an ordinary unlinked file with mode `0600`; the broker generates per-repository Ed25519 deploy keys in private project directories. Configured export paths remain separate and only expose source. Omitting `tokenFile` enables local project creation while leaving first GitHub publication unavailable.

GitHub's endpoint for creating a repository under a personal account accepts a fine-grained personal access token or a GitHub App **user** access token with repository Administration write permission. A normal repository deploy key cannot create repositories, and a GitHub App installation token alone is not listed as supported for this endpoint. See [GitHub repository creation authentication](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user). Deploy-key creation also requires Administration write permission; see [GitHub deploy-key permissions](https://docs.github.com/en/rest/deploy-keys/deploy-keys#create-a-deploy-key).

For the initial setup, the owner can create a dedicated expiring fine-grained token with Administration write and select **All repositories** under their personal account, so newly created repositories are covered. This credential administers provisioning and should be kept separate from the laptop's GitHub CLI OAuth token. The existing laptop credential has not been copied to the VPS by this implementation.

[Open the prefilled dedicated token form](https://github.com/settings/personal-access-tokens/new?name=Praxis%20project%20creation&description=Create%20Praxis%20projects%20and%20their%20repository-scoped%20deploy%20keys&target_name=JensenAbler&expires_in=90&administration=write). The owner must review the resource owner, repository access selection, expiry, and permission before generating it. Keep the token outside chat and Git; install it only in the protected file. GitHub documents these [prefilled token parameters](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters).

A GitHub App with user authorization and refresh tokens is a later alternative to manual token rotation. The personal-repository endpoint requires the user authorization flow, so creating only an installation key would not complete that setup.

GitHub documents that deleting a personal access token also deletes deploy keys created with it. Before deleting a provisioning token, replace or revalidate the keys it created. See [GitHub token deletion behavior](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#deleting-a-personal-access-token).

The independent updater keeps the installed Git broker, project provisioner, gateway authentication, and updater in the protected control layer. Routine self-update replaces the coding backend and its tool manifest. Candidate coding code therefore does not inherit the Git broker UID or its provisioning credential. Changes to protected control source require a separate maintenance path.

## Validation evidence

`test/projects.test.js` uses actual local bare repositories and source exports to verify scaffold execution, owner isolation, first publication, explicit public visibility, collisions, missing credentials, lost responses, and exact recovery. Its GitHub API behavior is a fixture.

`test/projects-mcp.test.js` drives all three authenticated HTTP/MCP services through create, workspace editing, local commit, initial private publication, service restart, and recovery/synchronization. Git execution and main verification are real local operations; GitHub HTTP calls are explicitly mocked. These tests do not establish a production GitHub token's permission or a phone run.
