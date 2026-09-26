# Application tool routing and control maintenance

The application manifest is data with version 1 and per-tool inputSchema and
route: {target, action}. Targets are exactly coding and git, mapped by control
configuration to fixed loopback HTTP /call endpoints. Existing application tools
route to coding using their public names; their Git staging and receipt
orchestration stays in the application. Internal schema target/method fields are
not gateway routes. A new direct broker tool must use the broker request contract.

Missing route fields mean exactly coding/tool-name for migration of existing v1
manifests. Exported manifests always declare routes. JavaScript compatibility
checks and the installed Python updater compare normalized routes and preserve
the previous schema/annotation compatibility rules. Existing routes cannot be
retargeted by routine release. New names can expose existing ordinary broker
actions without a gateway code change.

Gateway schema validation is convenience, not authority: the app controls the
manifest and can loosen it. The coding service and broker authenticate and
validate their own schemas independently. The gateway derives owner and scope
from the verified token, forwards that token, and permits health grants only for
fixed diagnostic name/action pairs targeting coding. It never derives privileges
from manifest write/destructive hints. Release names, observation names, probe
names and release actions cannot be used as manifest routes. Independent release
tools keep control-owned schemas/handlers and survive app or manifest failure.

The broker admits only its own supported actions. Its HTTP endpoint requires an
owner code token, strict action inputs, and token-derived commit authorship.
Repository/owner policy, deployment enablement, predecessor receipts, provisioning
policy, staging hashes, generation fence, and idempotency remain broker checks.
Queued execution and reconciliation recheck applicable repository/deployment
policy. Conversation approval of a named adoption remains an agent/owner workflow
requirement; a JSON flag is not proof of owner consent. Existing native root
commands remain owner-authorized capabilities; this change is not an OS sandbox.

Control maintenance computes the union of installed and candidate static import
closures for the canonical gateway, Claude facade, and git broker using Node's
parser without evaluating source. Dynamic loaders, escaping imports and linked
local imports fail closed pending an explicit resolver policy. The installed
dependency bundle and package metadata are separately frozen, as are explicit
owner helpers and protected non-source components. Changes outside this set are
inert, but remain covered by the full-tree acceptance digest. Stale app-schema
pins are retired when installing the candidate control policy.

New app tools and exposing already-supported ordinary broker actions require only
an app release. New broker capabilities, authentication/scope rules, endpoints,
release controls, runtime dependencies and owner-helper policy remain control
changes. The approved one-time maintenance allowlist covers this migration, the
pending project adoption broker code, and declarative deployment service contracts.

Maintenance replaces both deployment helpers and the installed updater host
validator, drains/restarts both gateways and the broker, and uses the installed
bootstrap rollback journal. It must be run from the owner's terminal, not a Praxis
job. Acceptance must come from the final tested release plan; run Python with -B.
After maintenance, apply the approved Apocrypha execStart/user target additions,
check deployment_status, exercise a no-op deployment at its verified current head,
and confirm Discord remains clean. Never touch Apocrypha data or its environment.
