# Dental CBCT Viewer

[![CI](https://github.com/kitsorfan/dental-cbct-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/kitsorfan/dental-cbct-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ec4b6.svg)](LICENSE)

A dental CBCT viewer that runs entirely in the browser. Open a scan folder and get a panoramic reconstruction, cross-sections along the arch, axial/coronal/sagittal slices, a 3D rendering, measurements and a one-click PDF report with serial cross-sections every millimetre. Nothing to install, nothing stored, and the scan never leaves your computer.

**[Open the viewer](https://kitsorfan.github.io/dental-cbct-viewer/)** · **[Try the demo scan](https://kitsorfan.github.io/dental-cbct-viewer/?demo)** · **[Download for offline use](https://github.com/kitsorfan/dental-cbct-viewer/releases/latest/download/dental-cbct-viewer.html)** · **[Privacy, live](https://kitsorfan.github.io/dental-cbct-viewer/#privacy)**

English · Ελληνικά · Français

![The viewer showing the synthetic demo scan](docs/screenshot.jpg)

<sub>All images in this README come from the built-in synthetic demo scan, not from a patient.</sub>

## Using it

1. Open the viewer online, or the downloaded `dental-cbct-viewer.html`, which also works offline from a USB stick or a shared folder.
2. Drag the scan folder onto the window, or click **Open scan…** and pick it. The patient's folder, the `Data` folder of an export or the root of a CD all work.
3. Click the panoramic to see the cross-section at that point. **PDF report** creates the whole document in one click.

The **?** button opens the user guide; the **ⓘ** button opens About, Privacy and Terms.

| | |
|---|---|
| Mouse wheel | Scroll slices · move the panoramic curve buccal/lingual · step the cross-section along the arch (1 mm by default) |
| Click the panoramic | Show the cross-section at that point |
| Right drag | Brightness / contrast (window/level) |
| Ctrl + wheel, middle drag | Zoom, pan |
| Double-click, **F** or ⤢ | Expand a view to fill the window |
| **S** or the camera icon | Save a view as PNG |

## Features

- **Dental views**: panoramic reconstruction along the arch (adjustable slab thickness, average or MIP), cross-sections perpendicular to the arch, linked axial/coronal/sagittal slices and a 3D view (bone surface, teeth surface, MIP, simulated X-ray).
- **CS 3D Imaging analyses**: when an export includes one, the arches and the traced inferior alveolar nerve canals are loaded and drawn on every view. For other scans, draw an arch by clicking along the teeth.
- **Measurements**: distances in mm and angles, on any 2D view.
- **PDF report**, created automatically on A4:
  - scan details, panoramic with the nerve canals, 3D and axial views;
  - serial cross-sections along the whole arch, every 1 mm by default (0.5, 2 or 5 mm on request), numbered and matched to marks on the panoramic;
  - the current views with every measurement in a table.
- **Exports**: PNG of any view and a snapshot of the whole layout.
- **Three languages**, picked from the browser or the toolbar: English, Greek and French.
- **Help centre** with a user guide, a live privacy check, About and Terms of use.

<p>
  <img src="docs/report-page-1.jpg" alt="PDF report, overview page" width="49%">
  <img src="docs/report-page-2.jpg" alt="PDF report, serial cross-sections every 1 mm" width="49%">
</p>

## Privacy and security

- **Nothing leaves your computer.** The viewer is a static page with no server side. Scans are read with the browser's file APIs and kept in memory; images and reports are created locally and go straight to your Downloads folder.
- **Nothing is stored.** No cookies, local storage, databases or analytics. The language choice lives only in the page address (`?lang=fr`).
- **The page is locked down.** A Content Security Policy lets only the viewer's own script run (pinned by its SHA-256 hash) and blocks every network connection, so even a bug could not send a scan anywhere.
- **See it live.** The Privacy tab (or the badge in the status bar) checks, while you watch, that no connections were made, that connection blocking is active, that nothing is saved in the browser, and what is in memory. It can also close the scan and erase it from memory.
- **Safe with any file.** Files are only read as image data and never executed. Implausible sizes, deep nesting, oversized or entity-declaring analysis files and malformed data are rejected with a clear message.

The online version is served by GitHub Pages, which, like any web host, sees that the page was requested; the offline file avoids even that. See [SECURITY.md](SECURITY.md) for details and how to report a problem privately.

## Supported scans

- DICOM CT series, one file per slice (with or without the `.dcm` extension) or a single multi-frame file.
- Uncompressed transfer syntaxes: implicit and explicit VR little endian; 8- or 16-bit, signed or unsigned.
- Character sets including UTF-8 and Greek (ISO 8859-7), so Greek patient names display correctly.
- Tested with Carestream CS 8100 3D exports (CS 3D Imaging).

Compressed DICOM (JPEG, JPEG 2000, JPEG-LS, RLE) is not supported yet; the viewer says so when it meets one. Most CBCT software can export uncompressed DICOM.

## Development

There are no dependencies; Node 22 or newer is needed only for the tests and the build.

```sh
npm run dev     # serve the source at http://127.0.0.1:8080
npm test        # unit tests: DICOM parsing and limits, reformatting, PDF writer, translations, build and CSP
npm run build   # bundle everything into dist/index.html
```

The tests generate their DICOM files in memory, so no patient data is needed or stored in the repository. `.gitignore` also blocks `.dcm` files, `DICOMDIR` and report PDFs.

| File | Purpose |
|---|---|
| `src/dicom.js` | DICOM parsing with input limits, series grouping, volume assembly, CS 3D Imaging analysis files |
| `src/reslice.js` | Orthogonal, panoramic and cross-sectional reformatting |
| `src/viewport.js` | 2D view rendering, zoom/pan and input |
| `src/vr.js` | WebGL2 ray-marched 3D rendering |
| `src/report.js`, `src/pdf.js` | PDF report layout and a small PDF writer |
| `src/phantom.js` | Synthetic demo scan |
| `src/i18n.js` | English, Greek and French strings, including the guide, privacy and terms pages |
| `src/app.js` | Application state, overlays, tools, help centre and exports |
| `scripts/build.mjs` | Inlines everything into one HTML file and pins the script hash in the CSP |

Pushing to `main` runs the tests and deploys the built page to GitHub Pages. Pushing a `v*` tag attaches `dental-cbct-viewer.html` to a GitHub release.

## Disclaimer

This software is for reviewing scans only. It is not a certified medical device and must not be used as the sole basis for diagnosis or treatment planning; use certified software for clinical decisions. The full [terms of use](https://kitsorfan.github.io/dental-cbct-viewer/#terms) are in the app.

This project is independent and not affiliated with or endorsed by Carestream Dental. Carestream and CS 3D Imaging are trademarks of their respective owners and are named only to describe file compatibility.

## License

[MIT](LICENSE) © 2026 Kitsos Orfanopoulos
