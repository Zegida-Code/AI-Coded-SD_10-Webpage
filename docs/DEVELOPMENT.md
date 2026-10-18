# Development notes

## Running locally

```sh
python -m http.server 8765 --directory web-app
```

Open <http://localhost:8765> (real device) or <http://localhost:8765/?demo> (simulated device).

## Deploying (GitHub Pages)

GitHub Pages lets browsers cache files for 10 minutes, so a visitor could get a new `index.html` with an old
`js/app.js`. Every script URL in `index.html` therefore carries a release version (`?v=…`, via an import map).
Before each release:

```sh
./bump-version.sh
git add -A && git commit -m "Release" && git push
```
