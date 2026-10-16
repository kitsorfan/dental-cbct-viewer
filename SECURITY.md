# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue, and never attach patient scans or other personal data to a report; describe the problem or share a synthetic file instead.

## How the viewer protects its users

- **Nothing leaves the computer.** The app is a static page with no server side. Scans are read with the browser's file APIs and kept in memory only.
- **Locked-down page.** The published build carries a Content Security Policy that allows only its own inline script (pinned by SHA-256 hash) and blocks every network connection, form submission, plugin and frame.
- **Nothing is stored.** No cookies, local storage, IndexedDB or caches are written; the language choice lives in the page address.
- **Untrusted input is bounded.** DICOM parsing rejects implausible image sizes, frame counts and sequence nesting, caps the number of files and the volume size, and turns malformed data into a clear error. CS 3D Imaging analysis files are refused if they declare a DTD or entities, and every coordinate must be a finite, bounded number.
- **No file is ever executed.** Files in a scan folder are read as bytes; anything that is not a DICOM image or an analysis file is ignored.
- **No third-party code.** The app has no runtime or build dependencies.

## Repository

Only the owner has write access. The default branch and release tags are protected against deletion and history rewrites, workflows run with read-only tokens unless a job needs more, actions are restricted to GitHub's own and pinned to commit hashes, and secret scanning with push protection is enabled.
