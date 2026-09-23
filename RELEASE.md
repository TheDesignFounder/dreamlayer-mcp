# Agent readiness release

Prepared version: `0.4.0-beta.2`. Keep `latest` on the stable image release.

1. Pass CI and review the diff, then merge.
2. With npm publisher authentication, run `pnpm test` and `npm publish --tag beta --access public`.
3. Verify `npm view @dreamlayer/mcp dist-tags` and install the published version in a clean directory.
4. Authenticate to the official MCP Registry and publish `server.json` after the npm package exists. The package `mcpName` and manifest namespace must match the publisher's GitHub identity.
5. Verify the registry entry and update the docs' pinned beta version only after publication.

Registry requirements: https://modelcontextprotocol.io/registry/quickstart
The manifest is prepared metadata, not evidence of a published registry listing.

The package defaults to `publishConfig.tag: beta`; still pass `--tag beta` explicitly. Re-review the recovery fixes before publication. README links use existing pages; the beta.2-only tool/automation pages are held outside the docs site until the packages are published. Restore those pages in a later docs change with the stated minimum version.
