# pdf-editor

Lightweight browser PDF editor with:

- PDF loading and rendering
- Pressure-sensitive pen tool (opacity from pointer pressure, with fallback)
- Adjustable smoothing mode (weighted)
- Highlighter tool with low-opacity marker style
- Color pickers for pen/highlighter
- Export annotated result as a PDF

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deploy to GitHub Pages

This project builds to a static `dist/` directory and uses relative asset paths, so it works on GitHub Pages project sites.

1. Push to `main`.
2. In repository settings, set **Pages** source to **GitHub Actions**.
3. The included workflow publishes the `dist/` build output.
