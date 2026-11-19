# Public repository publication guard

This is executable policy enforced by scripts and Git hooks, not a prompt.

## Local configuration

`.link-bot/publication-policy.json` is ignored deployment data. Keep repository
addresses, restricted markers and approved personal identities there, never in
source, tests or example configuration. Version `2` requires:

- `terms`: nonempty restricted-marker strings, selected for confidential
  affiliations, internal endpoints or data, not public product/SDK names.
- `gitIdentities`: nonempty `{name, email}` pairs approved for publication.
- `githubLogins`: nonempty approved personal GitHub logins.

Missing or invalid policy blocks protected operations. Public Feishu/Lark SDK
references are not inherently confidential. This is a rule-selection distinction,
not a file/path exemption; a newly published internal URL in any file is rejected.
The scanner contains no copy or encoding of the deployment-specific denylist.
Tests use isolated synthetic policies and disposable repositories.

Install hooks with `npm run guard:install`, or
`npm run guard:install -- --repo /path/to/checkout`. Existing custom hooks are not
replaced. The `prepare` lifecycle installs this repository's hooks. No global Git
configuration, credentials or identity is changed. Other host checkouts require
explicit installation. Runtime images install root-owned wrappers and hooks,
and mount the local policy read-only; old images/containers require an update.

## Publication scope

- Commits: activate for a GitHub origin (including its push URL), not merely an
  unrelated GitHub remote. Inspect effective author/committer, final message and
  trailers, and **complete staged contents of added/changed files**. Unchanged
  legacy files and unstaged replacements are not this commit's publication.
- Pushes: activate for the selected destination, including configured and
  effective/re-written URLs. Git's trusted pre-push hook provides the exact ref
  updates. Scan every outgoing commit's identity, metadata and changed blobs,
  including intermediate commits later reverted, plus ref/tag metadata. Do not
  scan unrelated local branches. For a new branch, exclude only history reached
  from branches advertised by that destination at inspection time; missing local
  objects or failed inspections require fetching/inspection before retrying.
  A genuinely new repository is checked through its complete ancestry.
- PRs: inspect final title/body (or body file), branch names, outgoing commits
  against the verified target base, and the authenticated **login**, not unrelated
  profile company/bio/email fields. The login and commit identities must be
  locally approved. No automatic login, credential replacement or identity swap.
  Creation requires explicit title/body. Editing checks retained title/body too.

Changed blobs are scanned in full, so modifying a legacy file containing a
restricted marker still fails. This does not certify or sanitize previously
published history; a separate explicit audit is needed for historical cleanup.

The manager independently wraps protected Git operations, including exported
task repositories. Runtime wrappers force the trusted hooks, reject hook bypass,
and preserve existing force-push restrictions. Automated merge/replay commits
remain unsupported: stage explicitly with `--no-commit` where supported, then
finish with a guarded commit. PR interactive editors, implicit publication text,
remote-only/unverifiable heads, PR base changes during edit, and alternate content
publication API writes are refused. Read API calls and unrelated actions API
writes are not blocked simply because they use `gh api`.

Known credentials, internal account identifiers and host home paths are checked
in addition to private markers. Matching is Unicode-normalized, case-insensitive
and removes invisible formatting characters. Changed binary/NUL or non-UTF-8
content, blobs over 16 MiB, submodules, conflicted indexes and LFS pointers require
separate inspection and are refused rather than silently skipped. Errors report
rule identifiers/locations, never the matching credential or source line.

## Operation and limits

```sh
npm run guard:install
npm run guard:index
npm run guard:head
```

`guard:head` checks the latest commit by default; the script also accepts a head
and verified base. For external CI integrations, `--ci <event-file>` checks the
event's actual commit range and PR metadata. CI, repository secrets and remote
rulesets are **not** installed or changed automatically. The policy remains local.

On rejection, stop and inspect. Correct the content or explicitly select an
approved personal identity; do not disable hooks, silently exempt paths, or
rewrite history to force publication.

Local hooks cannot defeat a machine administrator or a same-privilege actor
deliberately invoking unwrapped binaries. Remote mandatory checks require
separate configuration and trusted policy delivery. A finite marker policy
cannot prove the absence of every semantic relationship, unknown secret, encoded
payload or external object; human review remains necessary. No mathematical
guarantee of complete leak prevention is claimed.
