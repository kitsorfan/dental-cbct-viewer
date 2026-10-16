# Dental CBCT Viewer

[![CI](https://github.com/kitsorfan/dental-cbct-viewer/actions/workflows/ci.yml/badge.svg)](https://github.com/kitsorfan/dental-cbct-viewer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ec4b6.svg)](LICENSE)

A dental CBCT viewer that runs entirely in the browser. Open a scan folder and get a panoramic reconstruction, cross-sections along the arch, axial/coronal/sagittal slices, a 3D rendering, measurements and a one-click PDF report. Nothing to install, and the scan never leaves your computer.

**[Open the viewer](https://kitsorfan.github.io/dental-cbct-viewer/)** · **[Try it with the demo scan](https://kitsorfan.github.io/dental-cbct-viewer/?demo)** · **[Download for offline use](https://github.com/kitsorfan/dental-cbct-viewer/releases/latest/download/dental-cbct-viewer.html)**

![The viewer showing the synthetic demo scan](docs/screenshot.jpg)

<sub>All images in this README come from the built-in synthetic demo scan, not from a patient.</sub>

## Using it

1. Open the viewer (online, or the downloaded `dental-cbct-viewer.html`, which works offline from a USB stick or a shared folder).
2. Drag the scan folder onto the window, or click **Open scan…** and pick it. The patient's folder, the `Data` folder of an export, or the root of a CD/DVD all work.
3. Press **?** at any time to see every control.

The browser may ask whether to "upload" the folder. That is the browser's generic wording; the files are read locally and nothing is sent anywhere.

| | |
|---|---|
| Mouse wheel | Scroll slices · move the panoramic curve buccal/lingual · move the cross-section along the arch |
| Click the panoramic | Show the cross-section at that point |
| Right drag | Brightness / contrast (window/level) |
| Ctrl + wheel, middle drag | Zoom, pan |
| Double-click, **F**, or ⤢ | Expand a view to fill the window |
| **S** or the camera icon | Save a view as PNG |

## Features

- **Dental views**: panoramic reconstruction along the arch (adjustable slab thickness, average or MIP), cross-sections perpendicular to the arch, linked axial/coronal/sagittal slices and a 3D view (bone surface, teeth surface, MIP, simulated X-ray).
- **CS 3D Imaging analyses**: when the export includes one, the arches and the traced inferior alveolar nerve canals are loaded and drawn on every view. For other scans, draw an arch by clicking along the teeth.
- **Measurements**: distances in mm and angles, on any 2D view.
- **Exports**: PNG of any single view, a snapshot of the whole layout, and an automatic **A4 PDF report**: scan details, panoramic, 3D and axial views; 12 numbered cross-sections along the arch; your current views with every measurement listed.
- **English and Greek** interface (picked from the browser language, switchable in the toolbar).

<p>
  <img src="docs/report-page-1.jpg" alt="PDF report, overview page" width="49%">
  <img src="docs/report-page-2.jpg" alt="PDF report, cross-sections page" width="49%">
</p>

## Supported scans

- DICOM CT series, one file per slice (with or without the `.dcm` extension) or a single multi-frame file.
- Uncompressed transfer syntaxes: implicit and explicit VR little endian; 8- or 16-bit, signed or unsigned.
- Character sets including UTF-8 and Greek (ISO 8859-7), so Greek patient names display correctly.
- Tested with Carestream CS 8100 3D exports (CS 3D Imaging).

Compressed DICOM (JPEG, JPEG 2000, JPEG-LS, RLE) is not supported yet; the viewer says so when it meets one. Most CBCT software can export uncompressed DICOM.

## Privacy

The viewer is a single static page with no server side, no analytics and no network requests. Scans are read with the browser's file APIs and stay in memory on your machine. Reports and images are generated in the browser and saved straight to your downloads.

## Development

There are no dependencies; Node 22 or newer is only needed for the tests and the build.

```sh
npm run dev     # serve the source at http://127.0.0.1:8080
npm test        # unit tests (DICOM parsing, reformatting, PDF writer, translations, build)
npm run build   # bundle everything into dist/index.html
```

The tests generate their DICOM files in memory, so no patient data is needed or stored in the repository. `.gitignore` also blocks `.dcm` files and `DICOMDIR`.

| File | Purpose |
|---|---|
| `src/dicom.js` | DICOM parsing, series grouping, volume assembly, CS 3D Imaging analysis files |
| `src/reslice.js` | Orthogonal, panoramic and cross-sectional reformatting |
| `src/viewport.js` | 2D view rendering, zoom/pan and input |
| `src/vr.js` | WebGL2 ray-marched 3D rendering |
| `src/report.js`, `src/pdf.js` | PDF report layout and a small PDF writer |
| `src/phantom.js` | Synthetic demo scan |
| `src/i18n.js` | English and Greek strings |
| `src/app.js` | Application state, overlays, tools and exports |
| `scripts/build.mjs` | Inlines the modules and styles into one HTML file |

Pushing to `main` runs the tests and deploys the built page to GitHub Pages. Pushing a `v*` tag attaches `dental-cbct-viewer.html` to a GitHub release.

## Disclaimer

This software is for reviewing scans only. It is not a certified medical device and must not be used as the sole basis for diagnosis or treatment planning; use certified software for clinical decisions.

This project is independent and not affiliated with or endorsed by Carestream Dental. Carestream and CS 3D Imaging are trademarks of their respective owners and are named only to describe file compatibility.

## License

[MIT](LICENSE)
