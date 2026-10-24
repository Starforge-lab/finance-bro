# Security

Do not include financial records, account details, message or email contents, receipts, credentials, or other sensitive data in public issues or pull requests.

Private vulnerability reporting is enabled. Use **Security → Report a vulnerability** to submit a report privately; do not post vulnerability details in public issues or pull requests. Secret scanning and push protection, Dependabot alerts, and Dependabot security updates are also enabled (verified 2026-10-06).

## Known development-tooling advisories

The SDK 58.0.8 / React Native 0.88.0-rc.4 refresh was checked on 2026-10-13.
The 2026-10-24 freeze exception to Expo 58.0.19 / React Native 0.88.0 was checked
the same day: Expo's compatibility check passes and `pnpm audit` reports three
transitive advisories (two high, one moderate); no override or suppression was added.
Expo's compatibility check passes. The full-workspace `pnpm audit` still reports
four transitive advisories (two high, two moderate); no forced override or
advisory suppression was added. `expo-modules-core@58.0.16` still declares
Worklets peers only through 0.10.x while the supported app uses 0.13.0, as
confirmed by `pnpm peers check`; issue #3 retains that upstream warning.

The current full audit reports these findings in the development/build graph:

- `braces@3.0.3` — [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No patched version is listed by the current audit.
- `node-forge@1.4.0` — [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), which concerns RSA PKCS#1 v1.5 signature verification accepting extra nested `DigestAlgorithm` elements. No patched version was listed at the time of the audit. The affected dependency path reaches Expo CLI's code-signing helper, which verifies configured certificates through `validateSelfSignedCertificate`; keep this finding visible rather than dismissing it.
- `uuid@7.0.3`, through the `xcode` dependency path — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) concerns v3, v5, and v6 calls with caller-provided buffers. The reviewed path used the v4 API; no affected call was observed there.
- `esbuild@0.18.20`, through `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` — [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), concerning cross-origin access to esbuild's development server. The audit lists `>=0.25.0` as patched. Drizzle Kit is used for local migration generation, not shipped as app runtime code.

The audit lists no patched versions for `braces` or `node-forge`; `uuid` is patched in `>=11.1.1`. No forced major upgrade or override was applied. Coordinate tooling fixes with the maintainers and recheck this status as the SDK toolchain changes.
