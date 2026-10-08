# Encryption at Rest

> Part of the [Ythril Integration Guide](../integration-guide.md).

## Encryption at Rest

Ythril's state files — `config.json`, `secrets.json`, `schema-library.json`, `schema-catalogs.json` — and
**uploaded files** under `<data-root>/files/`, including the staging area a resumable upload passes through, can be
**encrypted at rest** so that a stolen file, or a co-tenant reading the volume on shared hardware, is useless without
the key. (Brain data in MongoDB is isolated per tenant by running each instance against its own encrypted `mongod` —
see [Running Multiple Brains on One Host](02-hosting.md#running-multiple-brains-on-one-host).)

Provide a **master secret via the environment** (never written to disk) and encryption turns on
transparently:

| Variable | Meaning |
|---|---|
| `YTHRIL_MASTER_KEY` | 32 raw bytes as base64 or 64 hex chars — used directly. Generate: `openssl rand -base64 32`. |
| `YTHRIL_MASTER_PASSPHRASE` | Any passphrase; a per-file scrypt salt is stored in the encrypted file. Used only if `YTHRIL_MASTER_KEY` is unset. |
| `YTHRIL_REQUIRE_ENCRYPTED_AT_REST` (or config `requireEncryptedAtRest`) | Refuse to boot unless a master secret is configured. |

- Files use **AES-256-GCM** (authenticated); a wrong key or a tampered file fails to decrypt and the
  instance refuses to start rather than silently continue.
- **Automatic migration:** if a key is configured and a file is still plaintext (e.g. after upgrading),
  it is encrypted **in place** at the next boot — round-trip verified first, with no plaintext copy left
  behind. New installs write encrypted from the first save.
- **Back up the master secret.** Losing it makes the encrypted files unrecoverable — that is the point.
  Deliver it as a Docker/Kubernetes/systemd secret, not baked into an image.

### Uploaded files

With a master secret set, every uploaded file is written encrypted, and every reader — downloads, `read_file`,
sync, indexing — gets the plaintext back. Nothing an API caller sees changes: sizes, hashes and the file manifest
describe the file as uploaded, so two peers compare equal whether either one encrypts.

- **The format** is chunked AES-256-GCM (64 KiB chunks, each authenticated, under a key derived per file), so a
  file of any size streams in and out without being held in memory (a download, the sync pull and push, and the window `read_file` and the extract return; the media pipeline reads a file whole only where a model needs the whole file). A flipped bit, a dropped, reordered or
  truncated chunk, or a file from another instance refuses to decrypt; it never decodes to something plausible.
- **Files stored before the secret was set are encrypted in the background** after each start, one at a time,
  each keeping its own modification time (so peers do not see an edit). Until that pass reaches a file it stays
  plaintext and keeps reading normally. A full disk stops the pass; the rest are encrypted on the next start.
- **The security posture reports it** as `atRest.files` (`GET /api/about/security`, and the boot log): *pass*
  while the pass runs and once it is done; *warn* when files are left plaintext, cannot be decrypted with this
  secret, or are encrypted on an instance with no secret. It never fails, so a strict instance still boots.
- **A file that cannot be decrypted is refused, never served raw.** A download answers `500` naming the file,
  `read_file` gives the same message, and indexing marks it failed rather than retrying. On an instance with **no**
  secret, an encrypted file is refused the same way — serving it would hand users ciphertext and publish it to every
  peer as the file's new version.
- **Sync sends plaintext**, over the transport you configured (HTTPS between peers), and each receiver stores what
  arrives by its own setting. Members of one network do not need the same key, or any key.
- **Rolling back** to a release from before this feature, on a tree that has been encrypted, leaves the old release
  reading ciphertext as if it were the file. Roll back only to a release that has it, or restore the files from a
  copy taken before the secret was set.
- **What stays readable on disk, deliberately:** file NAMES and folder structure, sizes rounded to the chunk, and in
  MongoDB each file's metadata and plaintext SHA-256 (which sync compares). The per-file key binds each chunk to its
  place in its own file, not to the file's path, so a file swapped for another encrypted file from the same instance
  decrypts — it cannot be altered, but it can be exchanged by someone who can already write the volume.
- **Temporary plaintext.** Audio and video indexing hands the media to `ffmpeg`, which needs a real file: a decrypted
  copy lives in the OS temp directory for the duration of that job and is removed after it. Put the temp directory
  on an encrypted or memory-backed volume if that window matters.
- **The data root must be one filesystem.** Writes land in `<data-root>/.stored-tmp/` and are renamed into place, and a
  rename cannot cross filesystems. Mounting `files/` from a different volume makes every write fail; the boot log
  says so in one line.
- **Kubernetes:** the shipped Deployment uses `strategy: Recreate`, so an old and a new pod never write the same
  volume at once during a rollout.

### What this does NOT cover

Stated here because the section title invites the wider reading:

- **database backups** under `<data-root>/backups/` are plaintext NDJSON unless the backup configuration's
  `encrypt` option is on — a dump reads *through* `mongod`, so an encrypted `mongod` does not protect it, and
  `requireEncryptedAtRest` does not cover it. See
  [POST /api/admin/data/backup](12-admin-api.md#post-apiadmindatabackup);
- **brain data in MongoDB itself** — that is the encrypted-`mongod` job described below;
- **an offsite copy** of `files/` taken alongside a backup is a copy of what is on disk — so it is ciphertext once the
  files are encrypted, and restoring it needs the same master secret.

Ythril writes uploads, the chunk staging area, local backups and offsite copies `0600`/`0700` — files
owner-read/write, directories owner-only — whether or not they are encrypted, so none of it is readable by other
users on the host or by another container sharing the mount. That comes from one definition in `util/fs-modes.ts`.

**On upgrade this heals rather than migrating.** A `mode:` argument only applies when a file is created, so files
that predate this keep their old permissions until something rewrites them — re-uploading, editing or moving a file
tightens it, and with a master secret the background encryption pass rewrites (and so tightens) every plaintext
file. Without one there is no boot-time walk. To tighten everything at once:

```bash
# inside the container, or against the mounted volume on the host
find /data/files /data/backups -type d -exec chmod 700 {} + -o -type f -exec chmod 600 {} +
```

```yaml
# docker compose — master key from a secret/env, kept out of the image
services:
  ythril:
    environment:
      YTHRIL_MASTER_KEY: "${YTHRIL_MASTER_KEY:?set a 32-byte base64 key}"
      YTHRIL_REQUIRE_ENCRYPTED_AT_REST: "true"
```
