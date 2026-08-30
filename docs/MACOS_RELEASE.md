# macOS release signing and notarization

Public macOS releases are fail-closed. `npm run package:mac` only produces the
normal release filename after all of these steps succeed:

1. Sign every Electron component and `drag-window` with a **Developer ID
   Application** certificate.
2. Enable Hardened Runtime and a secure timestamp.
3. Submit the app to Apple's notary service and wait for acceptance.
4. Staple the notarization ticket.
5. Verify the app and a quarantined extraction of the final ZIP with Gatekeeper.

An ad-hoc build is available only for local development:

```bash
npm run package:mac:dev
```

It is named `LLMPET-<version>-mac-<arch>-unsigned.zip`, so the Release workflow
cannot upload it accidentally.

## Required GitHub Actions secrets

Create a `Developer ID Application` certificate in the Apple Developer portal,
install it together with its private key, and export that identity as a
password-protected `.p12`. Configure these repository secrets:

| Secret | Purpose |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12_BASE64` | Base64-encoded `.p12` containing the Developer ID certificate and private key |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password generated for notarization |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Example secret setup (run locally; never commit the values):

```bash
base64 -i DeveloperIDApplication.p12 | tr -d '\n' | gh secret set APPLE_DEVELOPER_ID_P12_BASE64
gh secret set APPLE_DEVELOPER_ID_P12_PASSWORD
gh secret set APPLE_ID
gh secret set APPLE_APP_SPECIFIC_PASSWORD
gh secret set APPLE_TEAM_ID
```

The Release job imports the certificate into an ephemeral keychain and deletes
that keychain after the macOS job. The certificate and Apple credentials are
never written to the repository or release artifacts.

## Local verification

With the Developer ID identity installed in Keychain and the three notarization
environment variables set:

```bash
npm run package:mac
npm run verify:mac
```

`verify:mac` rejects ad-hoc signatures, missing team identifiers, missing
Hardened Runtime, missing notarization tickets, invalid ZIPs, and applications
that Gatekeeper rejects after a simulated browser download.
