# Development notes

## Running locally

```sh
python -m http.server 8765 --directory web-app
```

Open <http://localhost:8765> (real device) or <http://localhost:8765/?demo> (simulated device).

## Styles (Tailwind)

The page uses a precompiled stylesheet, `css/app.css`, built from `css/tailwind.src.css` with Tailwind v3.4
(config: `tailwind.config.js`). After adding or changing Tailwind classes in `index.html` or `js/`, rebuild it:

```sh
./build-css.sh                                   # uses tailwindcss on PATH, else npx tailwindcss@3.4.16
TAILWIND=/path/to/tailwindcss.exe ./build-css.sh # or the standalone CLI from the Tailwind v3.4.16 release
```

Class names assembled at runtime must be listed in `safelist` in `tailwind.config.js`.

## Deploying (GitHub Pages)

GitHub Pages lets browsers cache files for 10 minutes, so a visitor could get a new `index.html` with an old
`js/app.js`. Every script URL in `index.html` therefore carries a release version (`?v=…`, via an import map).
A new module in `js/` must also be added to that import map, or it loads without a version
(`test/mobile-check.html` checks that every module carries one). Before each release:

```sh
./bump-version.sh
git add -A && git commit -m "Release" && git push
```

## Tests

Serve the folder as above and open `test/index.html` (core code), `test/ui-smoke.html` (Console),
`test/mobile-check.html` (phone layout), `test/match-smoke.html` (Print match) and `test/space-smoke.html` (color
space). Each page sets its title to
`ALL PASS` when every check passes, so they can also run headless, e.g.
`chrome --headless=new --dump-dom http://localhost:8765/test/index.html`.
