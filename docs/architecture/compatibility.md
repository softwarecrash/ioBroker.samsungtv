# Compatibility contract

The modernization must preserve the user-visible behavior of version 0.0.25.

- Existing native configurations are migrated in place and receive a `schemaVersion`.
- Existing device IDs remain stable. A MAC address is preferred over an IP address.
- Existing object paths remain `samsungtv.<instance>.<friendly-name>.(info|state|control)`.
- Renaming a device migrates its object tree; removing it deletes the complete tree.
- Tizen, Samsung H/J and classic Samsung TCP control remain supported.
- Pairing secrets remain in `encryptedNative` and `protectedNative` configuration fields.
- Admin messages never return pairing tokens, H/J identities or decrypted configuration secrets.
- A failed migration must not delete a device, secret or object tree.

The sanitized fixture under `test/fixtures/native-config-v0.0.25.json` represents the pre-modernization format.
