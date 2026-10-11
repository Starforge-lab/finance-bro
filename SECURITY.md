# Security

Do not include financial records, account details, message or email contents, receipts, credentials, or other sensitive data in public issues or pull requests.

Private vulnerability reporting is enabled. Use **Security → Report a vulnerability** to submit a report privately; do not post vulnerability details in public issues or pull requests. Secret scanning and push protection, Dependabot alerts, and Dependabot security updates are also enabled (verified 2026-10-06).

## Known development-tooling advisories

The SDK 58.0.7 / React Native 0.88.0-rc.4 refresh on 2026-10-10 still reports
the same two high and two moderate advisories listed below. No forced override
or advisory suppression was added. Expo's compatibility check passes, but
`expo-modules-core@58.0.15` still declares Worklets peers only through 0.10.x
while the supported app uses 0.13.0; issue #3 retains that upstream warning.

The local-ledger dependency audit on 2026-10-06 additionally reported a moderate `esbuild@0.18.20` advisory through `drizzle-kit@0.31.11` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils`: [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), concerning cross-origin access to esbuild's development server. Drizzle Kit is used for local migration generation, not shipped as app runtime code. No transitive override was applied; review a compatible upstream tooling update separately. The full audit now reports two high and two moderate advisories, including the three below.

A `pnpm audit` on 2026-10-06 reported three transitive advisories (two high, one moderate). These findings were in development/build tooling:

- `braces@3.0.3` — [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No patched version was listed at the time of the audit.
- `node-forge@1.4.0` — [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv), which concerns RSA PKCS#1 v1.5 signature verification accepting extra nested `DigestAlgorithm` elements. No patched version was listed at the time of the audit. The affected dependency path reaches Expo CLI's code-signing helper, which verifies configured certificates through `validateSelfSignedCertificate`; keep this finding visible rather than dismissing it.
- `uuid@7.0.3`, through the `xcode` dependency path — [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) concerns v3, v5, and v6 calls with caller-provided buffers. The reviewed path used the v4 API; no affected call was observed there.

No forced major upgrade or override was applied. Coordinate toolchain fixes with the maintainers and validate the supported SDK dependency set. Recheck the audit as the SDK toolchain changes; this status may become outdated.
